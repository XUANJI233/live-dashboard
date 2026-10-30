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
const { enforceCommitments } = await import("../src/services/commitment-enforcement");
const { requestExceptionUnfreeze } = await import("../src/services/commitment-tools");
const { sendDeviceCommands } = await import("../src/services/device-control");
const { getControllerContext } = await import("../src/services/controller-context");
const { getSummarySettings, saveSummarySettings } = await import("../src/services/daily-summary-gen");

const PHONE = "android-commitments";
const TAOBAO = "com.taobao.taobao";
const JD = "com.jingdong.app.mall";
// 2026-10-30 23:30 at UTC+08:00, inside a 23:00-08:30 window.
const NIGHT = new Date("2026-10-30T15:30:00.000Z");
const NOON = new Date("2026-10-31T04:00:00.000Z");

function phone(frozen: string[], online = true): void {
  db.prepare(`
    INSERT OR REPLACE INTO device_states (
      device_id, device_name, platform, app_id, app_name, window_title, display_title,
      last_seen_at, extra, is_online
    ) VALUES (?, 'Phone', 'android', 'com.example.current', 'Current', '', 'Current', datetime('now'), ?, ?)
  `).run(PHONE, JSON.stringify({
    device: {
      profile: "android_lsp",
      capabilities: { freeze: true, unfreeze: true, vibrate: true, say: true },
      frozen_packages: frozen.map((name) => ({ package_name: name, app_name: name, until: "" })),
      installed_apps: [
        { package_name: TAOBAO, app_name: "淘宝" },
        { package_name: JD, app_name: "京东" },
        { package_name: "com.qidian.QDReader", app_name: "起点读书" },
      ],
    },
  }), online ? 1 : 0);
}

function shoppingBlock(window?: { start: string; end: string }) {
  return commitments.recordCommitment({
    kind: "block",
    title: "闭关期购物封禁",
    user_quote: "京东和淘宝长期封着，不许解",
    device_id: PHONE,
    packages: [TAOBAO, JD],
    ...(window ? { window_start: window.start, window_end: window.end } : {}),
  }, new Date("2026-10-30T00:00:00.000Z"));
}

function lastCommands(prefix: string) {
  return db.prepare(`
    SELECT payload FROM device_commands WHERE request_id LIKE ? ORDER BY issued_at DESC, rowid DESC
  `).all(`${prefix}%`).map((row) => JSON.parse((row as { payload: string }).payload).payload);
}

describe("commitments", () => {
  beforeEach(() => {
    db.run("DELETE FROM controller_commitments");
    db.run("DELETE FROM commitment_exceptions");
    db.run("DELETE FROM device_commands");
    db.run("DELETE FROM meta WHERE key LIKE 'commitment_%'");
    saveSummarySettings({ ...getSummarySettings(), supervision_enabled: true, supervision_lsp_freeze: true });
    phone([]);
  });
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite file locked until the process exits.
    }
  });

  test("a block rule needs a device, exact packages and a complete window", () => {
    const bad = [
      { kind: "block", title: "x", user_quote: "y", packages: [TAOBAO] },
      { kind: "block", title: "x", user_quote: "y", device_id: PHONE, packages: ["淘宝"] },
      { kind: "block", title: "x", user_quote: "y", device_id: PHONE, packages: [TAOBAO], window_start: "23:00" },
      { kind: "block", title: "x", user_quote: "y", device_id: PHONE, packages: [TAOBAO], ends_at: "2020-01-01T00:00:00Z" },
      { kind: "task", title: "", user_quote: "y" },
    ] as const;
    for (const input of bad) {
      expect(() => commitments.recordCommitment(input as never)).toThrow();
    }
    const task = commitments.recordCommitment({ kind: "task", title: "每天二十个新词", user_quote: "明天早饭后二十个新的" });
    expect(task).toMatchObject({ kind: "task", status: "active" });
    expect(task).not.toHaveProperty("packages");
  });

  test("an overnight window wraps midnight", () => {
    const row = getCommitment(String(shoppingBlock({ start: "23:00", end: "08:30" }).commitment_id))!;
    expect(commitments.commitmentInWindow(row, NIGHT)).toBe(true);
    expect(commitments.commitmentInWindow(row, new Date("2026-10-31T00:20:00.000Z"))).toBe(true);
    expect(commitments.commitmentInWindow(row, new Date("2026-10-31T00:30:00.000Z"))).toBe(false);
    expect(commitments.commitmentInWindow(row, NOON)).toBe(false);
  });

  test("a controller unfreeze cannot reach a committed package by name, label or catch-all", () => {
    shoppingBlock();
    const sent = sendDeviceCommands({
      request_id: "req_locked_unfreeze",
      commands: [{ device_id: PHONE, unfreeze_commands: [TAOBAO, "京东", "全部", "com.qidian.QDReader"] }],
    }).commands[0]!;
    expect(sent.payload.payload).toMatchObject({ unfreeze_commands: ["com.qidian.QDReader"] });
    expect((sent.payload.payload as { notes: string[] }).notes).toContain("commitment_locked");

    const refused = sendDeviceCommands({
      request_id: "req_locked_only",
      commands: [{ device_id: PHONE, unfreeze_commands: [TAOBAO] }],
    }).commands[0]!;
    expect(refused.result).toMatchObject({ status: "ignored" });
    expect(refused.delivery).toMatchObject({ status: "skipped", reason: "commitment_locked" });

    const enforced = sendDeviceCommands({
      request_id: "req_bypass",
      commands: [{ device_id: PHONE, unfreeze_commands: [TAOBAO] }],
    }, { bypassCommitments: true }).commands[0]!;
    expect(enforced.payload.payload).toMatchObject({ unfreeze_commands: [TAOBAO] });
  });

  test("an exception is time-boxed, counted per day and relocked by Live", async () => {
    shoppingBlock();
    const now = new Date();
    const granted = await requestExceptionUnfreeze({ device_id: PHONE, package_name: TAOBAO, purpose: "买火锅底料", minutes: 15 }, now);
    expect(granted).toMatchObject({ ok: true, package_name: TAOBAO, exceptions_left_today: 1 });
    expect(granted.relock_at).toBe(new Date(now.getTime() + 15 * 60_000).toISOString());
    expect(commitments.lockedPackages(PHONE, now).has(TAOBAO)).toBe(false);
    expect(lastCommands("commitment-exception-")[0]).toMatchObject({ unfreeze_commands: [TAOBAO] });

    await expect(requestExceptionUnfreeze({ device_id: PHONE, package_name: JD, purpose: "买东西", minutes: 45 }, now))
      .rejects.toThrow("exception_minutes_out_of_range");
    await expect(requestExceptionUnfreeze({ device_id: PHONE, package_name: JD, purpose: "", minutes: 10 }, now))
      .rejects.toThrow("exception_purpose_required");
    await expect(requestExceptionUnfreeze({ device_id: PHONE, package_name: "com.qidian.QDReader", purpose: "看书", minutes: 10 }, now))
      .rejects.toThrow("not_committed");
    await requestExceptionUnfreeze({ device_id: PHONE, package_name: JD, purpose: "交电费", minutes: 10 }, now);
    await expect(requestExceptionUnfreeze({ device_id: PHONE, package_name: JD, purpose: "再买一样", minutes: 10 }, now))
      .rejects.toThrow("commitment_exception_denied");

    // Time is up: the next tick freezes it again without anyone reporting back.
    phone([JD]);
    enforceCommitments(new Date(now.getTime() + 16 * 60_000));
    expect(lastCommands("commitment-freeze-")[0]).toMatchObject({ freeze_commands: [TAOBAO] });
    expect(commitments.lockedPackages(PHONE, new Date(now.getTime() + 16 * 60_000)).has(TAOBAO)).toBe(true);
  });

  test("an offline phone gets no exception and no quota is spent", async () => {
    shoppingBlock();
    phone([], false);
    await expect(requestExceptionUnfreeze({ device_id: PHONE, package_name: TAOBAO, purpose: "买药", minutes: 10 }))
      .rejects.toThrow("device_offline");
    expect(db.prepare("SELECT COUNT(*) AS count FROM commitment_exceptions").get()).toEqual({ count: 0 });
  });

  test("enforcement freezes what the phone lost, retries slowly, and releases a closed window", () => {
    const block = shoppingBlock({ start: "23:00", end: "08:30" });
    phone([JD]);

    expect(enforceCommitments(NIGHT)).toEqual({ freeze_requests: 1, unfreeze_requests: 0 });
    expect(lastCommands("commitment-freeze-")[0]).toMatchObject({ freeze_commands: [TAOBAO] });
    // The phone has not reported the new state yet: no second command within the retry interval.
    expect(enforceCommitments(new Date(NIGHT.getTime() + 5 * 60_000)).freeze_requests).toBe(0);
    // After the LSP 03:00 cleanup both are missing again.
    phone([]);
    enforceCommitments(new Date("2026-10-30T19:01:00.000Z"));
    expect(lastCommands("commitment-freeze-")[0]).toMatchObject({ freeze_commands: [TAOBAO, JD] });

    phone([TAOBAO, JD]);
    expect(enforceCommitments(NOON)).toEqual({ freeze_requests: 0, unfreeze_requests: 1 });
    expect(lastCommands("commitment-release-")[0]).toMatchObject({ unfreeze_commands: [TAOBAO, JD] });
    expect(enforceCommitments(new Date(NOON.getTime() + 60_000)).unfreeze_requests).toBe(0);

    expect(commitments.endCommitment(String(block.commitment_id), "闭关结束")).toMatchObject({ status: "ended" });
  });

  test("a package held by another rule is not released when one window closes", () => {
    shoppingBlock();
    commitments.recordCommitment({
      kind: "block", title: "夜间封禁", user_quote: "23 点后消遣全封", device_id: PHONE,
      packages: [TAOBAO, "com.qidian.QDReader"], window_start: "23:00", window_end: "08:30",
    }, new Date("2026-10-30T00:00:00.000Z"));
    phone([TAOBAO, JD, "com.qidian.QDReader"]);
    enforceCommitments(NIGHT);
    enforceCommitments(NOON);
    expect(lastCommands("commitment-release-")[0]).toMatchObject({ unfreeze_commands: ["com.qidian.QDReader"] });
  });

  test("every controller context carries the active commitments", () => {
    shoppingBlock();
    const context = getControllerContext({ mode: "companion" }) as { commitments: Array<Record<string, unknown>> };
    expect(context.commitments).toHaveLength(1);
    expect(context.commitments[0]).toMatchObject({
      title: "闭关期购物封禁",
      user_quote: "京东和淘宝长期封着，不许解",
      packages: [TAOBAO, JD],
      window: null,
      in_window_now: true,
      exceptions_left_today: 2,
    });
  });
});
