import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-commitment-limits-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

const { db } = await import("../src/db");
const { packageStates } = await import("../src/services/commitment-sync-store");
const { requestExceptionUnfreeze } = await import("../src/services/commitment-tools");
const { sendDeviceCommands } = await import("../src/services/device-control");
const { knownFrozenPackages } = await import("../src/services/device-frozen-knowledge");
const { getSummarySettings, saveSummarySettings } = await import("../src/services/daily-summary-gen");
const {
  AFTER_THREE, BILI, GAME, JD, NIGHT, PHONE, TAOBAO, freshPhone, nightRule, shoppingRule,
} = await import("./support/fake-lsp-phone");
type FakePhone = ReturnType<typeof freshPhone>;

// The Android LSP phone's own limits: sixteen unsent events (a receipt and a result per command,
// oldest dropped), eight frozen apps in its report, and freezes it places itself.

// 08:31 local on 2026-10-31, just after the night window.
const MORNING = new Date("2026-10-31T00:31:00.000Z");

let phone: FakePhone;

function sentUnfreeze(patterns: string[], id: string) {
  const command = sendDeviceCommands({ request_id: id, commands: [{ device_id: PHONE, unfreeze_commands: patterns }] }).commands[0]!;
  const payload = command.payload.payload as { unfreeze_commands: string[]; notes: string[] };
  return { command, patterns: payload.unfreeze_commands, notes: payload.notes ?? [] };
}

describe("commitment sync against the phone's limits", () => {
  beforeEach(() => {
    saveSummarySettings({ ...getSummarySettings(), supervision_enabled: true, supervision_lsp_freeze: true });
    phone = freshPhone();
  });
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite file locked until the process exits.
    }
  });

  test("a phone that holds only eight results never loses one of Live's", () => {
    phone.outbox = [];
    nightRule();
    const perTick = phone.settle(NIGHT, 6);
    // The burst after the phone's 03:00 cleanup is the same size.
    phone.clearAtThree();
    perTick.push(...phone.settle(AFTER_THREE, 6));
    expect(Math.max(...perTick)).toBeLessThanOrEqual(6);
    const states = [...packageStates(PHONE).values()].filter((state) => state.frozen_until);
    expect(states).toHaveLength(16);
    expect(states.every((state) => state.owned === 1)).toBe(true);

    phone.settle(MORNING, 6);
    expect(phone.frozen.size).toBe(0);
  });

  test("a freeze whose answer was lost stays Live's own and is released when the window ends", () => {
    nightRule();
    phone.settle(NIGHT, 4);
    phone.clearAtThree();
    // The phone applies the first burst after 03:00 but its results never reach Live.
    phone.dropResults = true;
    phone.tick(AFTER_THREE);
    phone.dropResults = false;
    phone.settle(new Date(AFTER_THREE.getTime() + 60_000), 30);

    expect(phone.frozen.size).toBe(16);
    expect([...packageStates(PHONE).values()].filter((state) => state.frozen_until).every((state) => state.owned === 1)).toBe(true);
    phone.settle(MORNING, 6);
    expect(phone.frozen.size).toBe(0);
  });

  test("a current phone's full report shows a freeze it lost, so Live freezes it again", () => {
    phone.currentFirmware();
    nightRule();
    phone.settle(NIGHT, 4);
    // Something on the phone lifts the twelfth freeze, far past an older build's eight-app report.
    const lifted = [...phone.frozen.keys()][11]!;
    phone.frozen.delete(lifted);
    phone.settle(new Date(NIGHT.getTime() + 10 * 60_000), 2);
    expect(phone.frozen.has(lifted)).toBe(true);
  });

  test("an older phone's eight-app report cannot show that loss", () => {
    nightRule();
    phone.settle(NIGHT, 4);
    const lifted = [...phone.frozen.keys()][11]!;
    phone.frozen.delete(lifted);
    phone.settle(new Date(NIGHT.getTime() + 10 * 60_000), 2);
    expect(phone.frozen.has(lifted)).toBe(false);
  });

  test("a new exception waits for the phone's answer to the last one, which keeps its quota", async () => {
    shoppingRule();
    phone.settle(NIGHT, 2);
    const openCount = () => (db.prepare("SELECT COUNT(*) AS count FROM commitment_exceptions WHERE status = 'open'").get() as { count: number }).count;
    phone.disconnect();
    expect(await requestExceptionUnfreeze({ device_id: PHONE, package_name: TAOBAO, purpose: "买药", minutes: 5 }, NIGHT))
      .toMatchObject({ results_pending: true });

    // Past relock_at, before the queued command expires.
    const later = new Date(NIGHT.getTime() + 6 * 60_000);
    phone.tick(later);
    await expect(requestExceptionUnfreeze({ device_id: PHONE, package_name: TAOBAO, purpose: "还没买", minutes: 5 }, later))
      .rejects.toThrow("exception_pending");
    expect(openCount()).toBe(1);

    // The phone fetches and runs the queued unfreeze late: the exception counts, and Taobao is locked again.
    const row = db.prepare("SELECT payload FROM device_commands WHERE request_id LIKE 'commitment-exception-%'").get() as { payload: string };
    phone.receive(JSON.parse(row.payload));
    expect(phone.frozen.has(TAOBAO)).toBe(false);
    phone.connect();
    phone.settle(new Date(later.getTime() + 60_000), 2);
    expect(phone.frozen.has(TAOBAO)).toBe(true);
    expect(openCount()).toBe(1);
  });

  test("an app the phone froze itself opens by name while a commitment holds others", () => {
    shoppingRule();
    phone.settle(NIGHT, 2);
    // Six more of the phone's own freezes fill its eight-app report, then its time limit freezes Bilibili.
    const fillers = ["com.ss.android.ugc.aweme", "com.taobao.idlefish", "com.xunmeng.pinduoduo", "com.taobao.etao", "com.qidian.QDReader", "com.taptap"];
    for (const name of [...fillers, BILI]) phone.frozen.set(name, { until: AFTER_THREE.toISOString(), reason: "使用时长到了" });
    phone.report();

    const byLabel = sentUnfreeze(["哔哩哔哩"], "req_bili_label");
    expect(byLabel.patterns).toEqual(["^tv\\.danmaku\\.bili$"]);
    expect(phone.frozen.has(BILI)).toBe(false);

    phone.frozen.set(BILI, { until: AFTER_THREE.toISOString(), reason: "使用时长到了" });
    const mixed = sentUnfreeze([TAOBAO, BILI, "com\\.nothing\\.installed"], "req_mixed");
    expect(mixed.patterns).toEqual(["^tv\\.danmaku\\.bili$"]);
    // The locked app is blamed on the commitment, the unknown one is reported as unknown.
    expect(mixed.notes).toEqual(expect.arrayContaining(["commitment_locked", "unfreeze_target_unknown"]));
    expect(phone.frozen.has(TAOBAO) && phone.frozen.has(JD) && !phone.frozen.has(BILI)).toBe(true);
  });

  test("an app opened again drops out of what Live knows is frozen", () => {
    shoppingRule();
    phone.settle(NIGHT, 2);
    sendDeviceCommands({ request_id: "req_game_freeze", commands: [{ device_id: PHONE, freeze_commands: [GAME], say: "学习时间" }] });
    phone.report();
    expect(knownFrozenPackages(PHONE).has(GAME)).toBe(true);

    expect(sentUnfreeze(["月圆之夜"], "req_game_open").patterns).toEqual(["^com\\.ztgame\\.yyzy$"]);
    phone.report();
    expect(knownFrozenPackages(PHONE).has(GAME)).toBe(false);
    // A catch-all no longer spends a slot on it.
    expect(sentUnfreeze(["全部"], "req_all").patterns).toEqual([]);

    sendDeviceCommands({ request_id: "req_game_refreeze", commands: [{ device_id: PHONE, freeze_commands: [GAME], say: "学习时间" }] });
    expect(knownFrozenPackages(PHONE).get(GAME)?.texts).toContain("学习时间");
  });
});
