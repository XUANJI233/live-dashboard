import { db } from "../../src/db";
import { recordCommitment } from "../../src/services/commitments";
import { enforceCommitments } from "../../src/services/commitment-enforcement";
import { recordCommandResult } from "../../src/services/device-command-ledger";
import { realtimeSocketHub } from "../../src/services/realtime-socket-hub";

// A stand-in for the Android LSP phone with its real limits, shared by the commitment tests.
// Import it only after the test file has set DB_PATH.

export const PHONE = "android-commitments";
export const TAOBAO = "com.taobao.taobao";
export const JD = "com.jingdong.app.mall";
export const GAME = "com.ztgame.yyzy";
export const BILI = "tv.danmaku.bili";
export const NIGHT_PACKAGES = [
  "com.ss.android.ugc.aweme", "com.xingin.xhs", TAOBAO, "com.taobao.idlefish", "com.xunmeng.pinduoduo", JD,
  "com.taobao.etao", BILI, "com.qidian.QDReader", "io.github.forkmaintainers.iceraven",
  "com.android.chrome", "com.microsoft.emmx", "com.taptap", "com.uhaozu.autoapp", GAME, "com.tencent.mobileqq",
  "com.netease.uuremote",
];
export const LABELS: Record<string, string> = {
  [TAOBAO]: "淘宝", [JD]: "京东", [GAME]: "月圆之夜", "com.qidian.QDReader": "起点读书", [BILI]: "哔哩哔哩",
};
// 2026-10-30 23:30 at UTC+08:00, inside a 23:00-08:30 window; the phone's freezes end at 03:00.
export const NIGHT = new Date("2026-10-30T15:30:00.000Z");
export const AFTER_THREE = new Date("2026-10-30T19:01:00.000Z");
export const NOON = new Date("2026-10-31T04:00:00.000Z");
export const RECORDED = new Date("2026-10-30T00:00:00.000Z");

export class FakePhone {
  frozen = new Map<string, { until: string; reason: string }>();
  installed = new Set(NIGHT_PACKAGES.filter((name) => name !== "com.xingin.xhs"));
  online = true;
  connected = true;
  now = NIGHT;
  received: Array<{ freeze: string[]; unfreeze: string[] }> = [];
  /**
   * Results waiting to upload, or null to upload each at once. The real phone keeps sixteen unsent
   * events, a receipt and a result per command, and drops the oldest.
   */
  outbox: Array<() => void> | null = null;
  outboxLimit = 8;
  /** Apply commands but never upload their results. */
  dropResults = false;
  /** An older build's limits by default: eight frozen apps per report, no total, sixteen records per unfreeze. */
  reportLimit = 8;
  reportsTotal = false;
  unfreezeScanLimit = 16;
  socket = {
    data: { role: "device", id: PHONE },
    send: (text: string) => this.receive(JSON.parse(text)),
    close() {},
    ping() {},
  };

  connect(): void {
    realtimeSocketHub.registerDevice(this.socket as never);
    this.connected = true;
  }

  disconnect(): void {
    realtimeSocketHub.removeDevice(this.socket as never);
    this.connected = false;
  }

  report(extra: { reason?: Record<string, string> } = {}): void {
    const frozen = [...this.frozen.entries()].slice(0, this.reportLimit).map(([name, record]) => ({
      package_name: name, app_name: LABELS[name] ?? name, until: record.until, reason: extra.reason?.[name] ?? record.reason,
    }));
    db.prepare(`
      INSERT OR REPLACE INTO device_states (
        device_id, device_name, platform, app_id, app_name, window_title, display_title, last_seen_at, extra, is_online
      ) VALUES (?, 'Phone', 'android', 'com.example.current', 'Current', '', 'Current', ?, ?, ?)
    `).run(PHONE, this.now.toISOString(), JSON.stringify({
      device: {
        profile: "android_lsp",
        capabilities: { freeze: true, unfreeze: true, vibrate: true, say: true },
        frozen_packages: frozen,
        ...(this.reportsTotal ? { frozen_packages_total: this.frozen.size } : {}),
        installed_apps: [...this.installed].map((name) => ({ package_name: name, app_name: LABELS[name] ?? name })),
      },
    }), this.online ? 1 : 0);
  }

  receive(envelope: { command_id: string; request_id: string; payload: { freeze_commands: string[]; unfreeze_commands: string[]; say?: string } }): void {
    const { freeze_commands: freeze, unfreeze_commands: unfreeze } = envelope.payload;
    this.received.push({ freeze, unfreeze });
    const actions: Array<Record<string, unknown>> = [];
    const until = nextThree(this.now);
    for (const pattern of freeze) {
      const matcher = new RegExp(pattern, "i");
      const targets = [...this.installed].filter((name) => matcher.test(name) || matcher.test(LABELS[name] ?? ""));
      if (targets.length === 0) actions.push({ action: "freeze", status: "ignored", reason: "no_installed_or_foreground_app_matched" });
      for (const name of targets) {
        const existing = this.frozen.get(name);
        // The phone keeps the command's say as the freeze reason.
        if (!existing) this.frozen.set(name, { until, reason: envelope.payload.say ?? "" });
        actions.push({ action: "freeze", status: "applied", package_name: name, until: existing?.until ?? until, ...(existing ? { reason: "already_frozen" } : {}) });
      }
    }
    for (const pattern of unfreeze) {
      const all = ["全部", "全量", "所有", "all", "*", ".*"].includes(pattern);
      const matcher = all ? null : new RegExp(pattern, "i");
      // An older build scans only its first 16 frozen records for an unfreeze.
      const scanned = [...this.frozen.entries()].slice(0, this.unfreezeScanLimit);
      const hits = scanned.filter(([name, record]) => all || matcher!.test(name) || matcher!.test(LABELS[name] ?? "") || matcher!.test(record.reason));
      if (hits.length === 0) actions.push({ action: "unfreeze", status: "ignored", reason: "no_frozen_app_matched" });
      for (const [name] of hits) {
        this.frozen.delete(name);
        actions.push({ action: "unfreeze", status: "applied", package_name: name });
      }
    }
    const applied = actions.some((action) => action.status === "applied");
    const upload = () => recordCommandResult({ commandId: envelope.command_id, requestId: envelope.request_id, status: applied ? "applied" : "ignored", actions });
    if (this.dropResults) return;
    if (!this.outbox) {
      upload();
      return;
    }
    this.outbox.push(upload);
    while (this.outbox.length > this.outboxLimit) this.outbox.shift();
  }

  /** Upload whatever results the phone still holds. */
  flush(): void {
    const pending = this.outbox ?? [];
    if (this.outbox) this.outbox = [];
    for (const upload of pending) upload();
  }

  /** Today's build: every freeze in the report with a total, and a full unfreeze scan. */
  currentFirmware(): void {
    this.reportLimit = 80;
    this.reportsTotal = true;
    this.unfreezeScanLimit = 256;
  }

  clearAtThree(): void {
    this.frozen.clear();
  }

  /** One enforcement minute: the phone uploads what it holds and reports, then Live reconciles. */
  tick(at: Date): ReturnType<typeof enforceCommitments> {
    this.flush();
    this.now = at;
    this.report();
    return enforceCommitments(at);
  }

  /** Tick once a minute from `from`; returns the commands each tick sent. */
  settle(from: Date, minutes = 5): number[] {
    const sent: number[] = [];
    for (let minute = 0; minute < minutes; minute += 1) {
      const before = this.received.length;
      this.tick(new Date(from.getTime() + minute * 60_000));
      sent.push(this.received.length - before);
    }
    return sent;
  }
}

/** His all-day shopping block on Taobao and JD. */
export function shoppingRule(): Record<string, unknown> {
  return recordCommitment({
    title: "闭关期购物封禁",
    user_quote: "冻结我淘宝和京东",
    device_id: PHONE,
    packages: [TAOBAO, JD],
  }, RECORDED);
}

/** His 17-app night block, 23:00-08:30, one 15-minute exception a day. */
export function nightRule(): Record<string, unknown> {
  return recordCommitment({
    title: "夜间封禁",
    user_quote: "11点手机还开着就全冻结，只留支付宝和微信",
    device_id: PHONE,
    packages: NIGHT_PACKAGES,
    window_start: "23:00",
    window_end: "08:30",
    daily_exception_limit: 1,
    max_exception_minutes: 15,
  }, RECORDED);
}

/** Empty the commitment and device tables and start a connected phone that has reported once. */
export function freshPhone(): FakePhone {
  for (const table of ["controller_commitments", "commitment_exceptions", "commitment_package_state", "device_commands", "device_states"]) {
    db.run(`DELETE FROM ${table}`);
  }
  const phone = new FakePhone();
  phone.connect();
  phone.report();
  return phone;
}

export function nextThree(now: Date): string {
  const local = new Date(now.getTime() + 8 * 60 * 60_000);
  const three = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 3) - 8 * 60 * 60_000);
  return (three.getTime() > now.getTime() ? three : new Date(three.getTime() + 24 * 60 * 60_000)).toISOString();
}
