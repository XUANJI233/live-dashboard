import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-commitments-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

const { db } = await import("../src/db");
const commitments = await import("../src/services/commitments");
const { getCommitment } = await import("../src/services/commitment-store");
const { packageStates } = await import("../src/services/commitment-sync-store");
const { enforceCommitments } = await import("../src/services/commitment-enforcement");
const { requestExceptionUnfreeze } = await import("../src/services/commitment-tools");
const { sendDeviceCommands } = await import("../src/services/device-control");
const { recordCommandResult } = await import("../src/services/device-command-ledger");
const { realtimeSocketHub } = await import("../src/services/realtime-socket-hub");
const { getControllerContext } = await import("../src/services/controller-context");
const { getSummarySettings, saveSummarySettings } = await import("../src/services/daily-summary-gen");

const PHONE = "android-commitments";
const TAOBAO = "com.taobao.taobao";
const JD = "com.jingdong.app.mall";
const GAME = "com.ztgame.yyzy";
const NIGHT_PACKAGES = [
  "com.ss.android.ugc.aweme", "com.xingin.xhs", TAOBAO, "com.taobao.idlefish", "com.xunmeng.pinduoduo", JD,
  "com.taobao.etao", "tv.danmaku.bili", "com.qidian.QDReader", "io.github.forkmaintainers.iceraven",
  "com.android.chrome", "com.microsoft.emmx", "com.taptap", "com.uhaozu.autoapp", GAME, "com.tencent.mobileqq",
  "com.netease.uuremote",
];
const LABELS: Record<string, string> = { [TAOBAO]: "淘宝", [JD]: "京东", [GAME]: "月圆之夜", "com.qidian.QDReader": "起点读书" };
// 2026-10-30 23:30 at UTC+08:00, inside a 23:00-08:30 window; the phone's freezes end at 03:00.
const NIGHT = new Date("2026-10-30T15:30:00.000Z");
const AFTER_THREE = new Date("2026-10-30T19:01:00.000Z");
const NOON = new Date("2026-10-31T04:00:00.000Z");
const RECORDED = new Date("2026-10-30T00:00:00.000Z");

/** A stand-in for the Android LSP phone with its real limits. */
class FakePhone {
  frozen = new Map<string, { until: string; reason: string }>();
  installed = new Set(NIGHT_PACKAGES.filter((name) => name !== "com.xingin.xhs"));
  online = true;
  connected = true;
  now = NIGHT;
  received: Array<{ freeze: string[]; unfreeze: string[] }> = [];
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
    const frozen = [...this.frozen.entries()].slice(0, 8).map(([name, record]) => ({
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
        installed_apps: [...this.installed].map((name) => ({ package_name: name, app_name: LABELS[name] ?? name })),
      },
    }), this.online ? 1 : 0);
  }

  private receive(envelope: { command_id: string; request_id: string; payload: { freeze_commands: string[]; unfreeze_commands: string[] } }): void {
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
        if (!existing) this.frozen.set(name, { until, reason: "" });
        actions.push({ action: "freeze", status: "applied", package_name: name, until: existing?.until ?? until, ...(existing ? { reason: "already_frozen" } : {}) });
      }
    }
    for (const pattern of unfreeze) {
      const all = ["全部", "全量", "所有", "all", "*", ".*"].includes(pattern);
      const matcher = all ? null : new RegExp(pattern, "i");
      // The phone scans only its first 16 frozen records for an unfreeze.
      const scanned = [...this.frozen.entries()].slice(0, 16);
      const hits = scanned.filter(([name, record]) => all || matcher!.test(name) || matcher!.test(LABELS[name] ?? "") || matcher!.test(record.reason));
      if (hits.length === 0) actions.push({ action: "unfreeze", status: "ignored", reason: "no_frozen_app_matched" });
      for (const [name] of hits) {
        this.frozen.delete(name);
        actions.push({ action: "unfreeze", status: "applied", package_name: name });
      }
    }
    const applied = actions.some((action) => action.status === "applied");
    recordCommandResult({ commandId: envelope.command_id, requestId: envelope.request_id, status: applied ? "applied" : "ignored", actions });
  }

  clearAtThree(): void {
    this.frozen.clear();
  }
}

function nextThree(now: Date): string {
  const local = new Date(now.getTime() + 8 * 60 * 60_000);
  const three = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 3) - 8 * 60 * 60_000);
  return (three.getTime() > now.getTime() ? three : new Date(three.getTime() + 24 * 60 * 60_000)).toISOString();
}

let phone: FakePhone;

function tick(at: Date): ReturnType<typeof enforceCommitments> {
  phone.now = at;
  phone.report();
  return enforceCommitments(at);
}

function shopping() {
  return commitments.recordCommitment({
    kind: "block",
    title: "闭关期购物封禁",
    user_quote: "冻结我淘宝和京东",
    device_id: PHONE,
    packages: [TAOBAO, JD],
  }, RECORDED);
}

function night() {
  return commitments.recordCommitment({
    kind: "block",
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

describe("commitments", () => {
  beforeEach(() => {
    for (const table of ["controller_commitments", "commitment_exceptions", "commitment_package_state", "device_commands", "device_states"]) {
      db.run(`DELETE FROM ${table}`);
    }
    saveSummarySettings({ ...getSummarySettings(), supervision_enabled: true, supervision_lsp_freeze: true });
    phone = new FakePhone();
    phone.connect();
    phone.report();
  });
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite file locked until the process exits.
    }
  });

  test("a block rule needs a freezing device, exact packages, a full window and an explicit end clock", () => {
    const base = { kind: "block" as const, title: "x", user_quote: "y", device_id: PHONE, packages: [TAOBAO] };
    expect(() => commitments.recordCommitment({ ...base, device_id: "missing-phone" })).toThrow("device_not_found");
    expect(() => commitments.recordCommitment({ ...base, packages: ["淘宝"] })).toThrow("invalid_commitment_package");
    expect(() => commitments.recordCommitment({ ...base, window_start: "23:00" })).toThrow("invalid_commitment_window");
    expect(() => commitments.recordCommitment({ ...base, ends_at: "2099-01-01T00:00:00" })).toThrow("invalid_commitment_end");
    expect(() => commitments.recordCommitment({ ...base, ends_at: "2020-01-01T00:00:00Z" })).toThrow("invalid_commitment_end");
    db.prepare("INSERT INTO device_states (device_id, device_name, platform, app_id, app_name, window_title, display_title, last_seen_at, extra, is_online) VALUES ('plain', 'P', 'android', '', '', '', '', datetime('now'), ?, 1)")
      .run(JSON.stringify({ device: { profile: "android_normal" } }));
    expect(() => commitments.recordCommitment({ ...base, device_id: "plain" })).toThrow("device_cannot_freeze");

    const recorded = commitments.recordCommitment({ ...base, packages: [TAOBAO, "com.xingin.xhs"], ends_at: "2099-01-01T00:00:00+08:00" });
    expect(recorded).toMatchObject({ status: "active", ends_at: "2098-12-31T16:00:00.000Z", not_installed: ["com.xingin.xhs"] });
    const task = commitments.recordCommitment({ kind: "task", title: "每天二十个新词", user_quote: "明天早饭后二十个新的" });
    expect(task).not.toHaveProperty("packages");
  });

  test("recording the same rule twice returns the first one", () => {
    const first = shopping();
    const again = shopping();
    expect(again).toMatchObject({ commitment_id: first.commitment_id, duplicate: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM controller_commitments").get()).toEqual({ count: 1 });
  });

  test("an overnight window wraps midnight", () => {
    const row = getCommitment(String(night().commitment_id))!;
    expect(commitments.commitmentInWindow(row, NIGHT)).toBe(true);
    expect(commitments.commitmentInWindow(row, new Date("2026-10-31T00:20:00.000Z"))).toBe(true);
    expect(commitments.commitmentInWindow(row, new Date("2026-10-31T00:30:00.000Z"))).toBe(false);
    expect(commitments.commitmentInWindow(row, NOON)).toBe(false);
  });

  test("a 17-app night rule is frozen per package, survives the 03:00 cleanup and is fully released", () => {
    night();
    expect(tick(NIGHT)).toEqual({ freeze_requests: 1, unfreeze_requests: 0 });
    expect(phone.received).toHaveLength(17);
    expect(phone.received.every((command) => command.freeze.length === 1 && command.freeze[0]!.startsWith("^"))).toBe(true);
    expect([...phone.frozen.keys()].sort()).toEqual(NIGHT_PACKAGES.filter((name) => name !== "com.xingin.xhs").sort());

    // The report lists only eight, yet nothing is re-sent while the phone's own expiry holds.
    phone.received = [];
    expect(tick(new Date(NIGHT.getTime() + 60_000))).toEqual({ freeze_requests: 0, unfreeze_requests: 0 });
    // The missing app is not retried every minute.
    expect(phone.received).toHaveLength(0);

    phone.clearAtThree();
    tick(AFTER_THREE);
    expect(phone.frozen.size).toBe(16);

    phone.received = [];
    tick(NOON);
    expect(phone.received.every((command) => command.unfreeze.length === 1)).toBe(true);
    // The phone scanned only sixteen records, so anything it missed is retried until confirmed.
    for (let minute = 1; phone.frozen.size > 0 && minute < 15; minute += 1) tick(new Date(NOON.getTime() + minute * 60_000));
    expect(phone.frozen.size).toBe(0);
    tick(new Date(NOON.getTime() + 20 * 60_000));
    expect(packageStates(PHONE).size).toBe(0);
  });

  test("an app the phone does not have is retried hourly, not every minute", () => {
    night();
    tick(NIGHT);
    // Results arrive asynchronously; the next tick takes them in.
    tick(new Date(NIGHT.getTime() + 60_000));
    const xhs = packageStates(PHONE).get("com.xingin.xhs")!;
    expect(Date.parse(xhs.retry_after) - NIGHT.getTime()).toBeGreaterThanOrEqual(59 * 60_000);
    phone.installed.add("com.xingin.xhs");
    phone.received = [];
    tick(new Date(NIGHT.getTime() + 61 * 60_000));
    expect(phone.received.map((command) => command.freeze[0])).toEqual(["^com\\.xingin\\.xhs$"]);
  });

  test("a controller unfreeze cannot reach a committed package by name, label, reason, alias or Java syntax", () => {
    shopping();
    tick(NIGHT);
    sendDeviceCommands({ request_id: "req_game", commands: [{ device_id: PHONE, freeze_commands: [GAME] }] });
    phone.report({ reason: { [TAOBAO]: "购物先停一下" } });

    const send = (patterns: string[], id: string) => sendDeviceCommands({ request_id: id, commands: [{ device_id: PHONE, unfreeze_commands: patterns }] }).commands[0]!;
    for (const alias of ["所有", "全量", "全部"]) {
      const sent = send([alias], `req_alias_${alias}`);
      expect(sent.payload.payload).toMatchObject({ unfreeze_commands: ["^com\\.ztgame\\.yyzy$"] });
      expect((sent.payload.payload as { notes: string[] }).notes).toContain("commitment_locked");
      sendDeviceCommands({ request_id: `req_refreeze_${alias}`, commands: [{ device_id: PHONE, freeze_commands: [GAME] }] });
    }
    // 淘\p{L} compiles in JavaScript as a literal "p{L}" but is a letter class to the phone's Java regex.
    for (const pattern of ["淘宝", "京东", "购物", TAOBAO, String.raw`淘\p{L}`]) {
      const sent = send([pattern], `req_locked_${pattern}`);
      expect(sent.result).toMatchObject({ status: "ignored" });
      expect(sent.delivery).toMatchObject({ status: "skipped", reason: "commitment_locked" });
    }
    expect(phone.frozen.has(TAOBAO) && phone.frozen.has(JD)).toBe(true);

    const unrelated = send(["com.qidian"], "req_unrelated");
    expect(unrelated.payload.payload).toMatchObject({ unfreeze_commands: ["com.qidian"] });
    const enforced = sendDeviceCommands({ request_id: "req_bypass", commands: [{ device_id: PHONE, unfreeze_commands: [TAOBAO] }] }, { bypassCommitments: true }).commands[0]!;
    expect(enforced.payload.payload).toMatchObject({ unfreeze_commands: [TAOBAO] });
  });

  test("an exception opens a package held by two rules, spends each quota once and is relocked", async () => {
    shopping();
    night();
    tick(NIGHT);
    const now = new Date(NIGHT.getTime() + 60_000);
    phone.now = now;

    const granted = await requestExceptionUnfreeze({ device_id: PHONE, package_name: TAOBAO, purpose: "买胃药", minutes: 20 }, now)
      .catch((error: Error) => error.message);
    expect(granted).toBe("exception_minutes_out_of_range");
    const opened = await requestExceptionUnfreeze({ device_id: PHONE, package_name: TAOBAO, purpose: "买胃药", minutes: 10 }, now);
    expect(opened).toMatchObject({ ok: true, exceptions_left_today: 0 });
    expect(opened.commitment_ids).toHaveLength(2);
    expect(phone.frozen.has(TAOBAO)).toBe(false);
    expect(commitments.lockedPackages(PHONE, now).has(TAOBAO)).toBe(false);

    // Asking again while it is open reuses it instead of spending another slot.
    expect(await requestExceptionUnfreeze({ device_id: PHONE, package_name: TAOBAO, purpose: "还没买完", minutes: 10 }, now))
      .toMatchObject({ reused: true });
    // The overlapping night rule does not re-freeze it during the exception.
    tick(new Date(now.getTime() + 5 * 60_000));
    expect(phone.frozen.has(TAOBAO)).toBe(false);
    // The night rule's single exception is spent.
    await expect(requestExceptionUnfreeze({ device_id: PHONE, package_name: JD, purpose: "交电费", minutes: 5 }, now))
      .rejects.toThrow("commitment_exception_denied");

    tick(new Date(now.getTime() + 11 * 60_000));
    expect(phone.frozen.has(TAOBAO)).toBe(true);
  });

  test("an exception that never reaches the phone spends no quota", async () => {
    shopping();
    tick(NIGHT);
    phone.disconnect();
    await expect(requestExceptionUnfreeze({ device_id: PHONE, package_name: TAOBAO, purpose: "买药", minutes: 10 }, NIGHT))
      .rejects.toThrow("exception_not_delivered");
    phone.online = false;
    phone.report();
    await expect(requestExceptionUnfreeze({ device_id: PHONE, package_name: TAOBAO, purpose: "买药", minutes: 10 }, NIGHT))
      .rejects.toThrow("device_offline");
    expect(db.prepare("SELECT COUNT(*) AS count FROM commitment_exceptions WHERE status = 'open'").get()).toEqual({ count: 0 });
  });

  test("ending a rule releases its packages unless another rule still holds them", () => {
    const shoppingRule = shopping();
    const nightRule = night();
    tick(NIGHT);
    commitments.endCommitment(String(nightRule.commitment_id), "不需要了", new Date(NIGHT.getTime() + 60_000));
    for (let minute = 2; minute < 8; minute += 1) tick(new Date(NIGHT.getTime() + minute * 60_000));
    expect([...phone.frozen.keys()].sort()).toEqual([JD, TAOBAO].sort());
    commitments.endCommitment(String(shoppingRule.commitment_id), "闭关结束", new Date(NIGHT.getTime() + 9 * 60_000));
    for (let minute = 10; minute < 14; minute += 1) tick(new Date(NIGHT.getTime() + minute * 60_000));
    expect(phone.frozen.size).toBe(0);
  });

  test("every controller context carries the active commitments", () => {
    shopping();
    const context = getControllerContext({ mode: "companion" }) as { commitments: Array<Record<string, unknown>> };
    expect(context.commitments).toHaveLength(1);
    expect(context.commitments[0]).toMatchObject({
      title: "闭关期购物封禁",
      packages: [TAOBAO, JD],
      window: null,
      in_window_now: true,
      exceptions_left_today: 2,
    });
  });
});
