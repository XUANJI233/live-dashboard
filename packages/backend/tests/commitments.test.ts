import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-commitments-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

// A database from before the ledger still holds a recorded-only task promise next to a block rule.
{
  const { Database } = await import("bun:sqlite");
  const legacy = new Database(process.env.DB_PATH, { create: true });
  legacy.run(`
    CREATE TABLE controller_commitments (
      commitment_id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, user_quote TEXT NOT NULL,
      device_id TEXT NOT NULL DEFAULT '', packages TEXT NOT NULL DEFAULT '[]', window_start TEXT NOT NULL DEFAULT '',
      window_end TEXT NOT NULL DEFAULT '', timezone_offset_minutes INTEGER NOT NULL DEFAULT -480, starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL DEFAULT '', daily_exception_limit INTEGER NOT NULL DEFAULT 2,
      max_exception_minutes INTEGER NOT NULL DEFAULT 30, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, ended_at TEXT NOT NULL DEFAULT '', end_reason TEXT NOT NULL DEFAULT ''
    )
  `);
  const insert = legacy.prepare(`
    INSERT INTO controller_commitments (commitment_id, kind, title, user_quote, starts_at, created_at, updated_at)
    VALUES (?, ?, 'x', 'y', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
  `);
  insert.run("cmt_legacy_task", "task");
  insert.run("cmt_legacy_block", "block");
  legacy.close();
}

const { db } = await import("../src/db");
const legacyKinds = db.prepare("SELECT kind FROM controller_commitments ORDER BY kind").all();
const commitments = await import("../src/services/commitments");
const { getCommitment } = await import("../src/services/commitment-store");
const { packageStates } = await import("../src/services/commitment-sync-store");
const { enforceCommitments } = await import("../src/services/commitment-enforcement");
const { requestExceptionUnfreeze } = await import("../src/services/commitment-tools");
const { sendDeviceCommands } = await import("../src/services/device-control");
const { getControllerContext } = await import("../src/services/controller-context");
const { getSummarySettings, saveSummarySettings } = await import("../src/services/daily-summary-gen");
const {
  AFTER_THREE, GAME, JD, NIGHT, NIGHT_PACKAGES, NOON, PHONE, RECORDED, TAOBAO,
  freshPhone, nightRule: night, shoppingRule: shopping,
} = await import("./support/fake-lsp-phone");
type FakePhone = ReturnType<typeof freshPhone>;

let phone: FakePhone;

function tick(at: Date): ReturnType<typeof enforceCommitments> {
  return phone.tick(at);
}

describe("commitments", () => {
  beforeEach(() => {
    saveSummarySettings({ ...getSummarySettings(), supervision_enabled: true, supervision_lsp_freeze: true });
    phone = freshPhone();
  });
  afterEach(() => setSystemTime());
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite file locked until the process exits.
    }
  });

  test("a block rule needs a freezing device, exact packages, a full window and an explicit end clock", () => {
    const base = { title: "x", user_quote: "y", device_id: PHONE, packages: [TAOBAO] };
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
    expect(() => commitments.recordCommitment({ title: "每天二十个新词", user_quote: "明天早饭后二十个新的" })).toThrow("invalid_commitment");
  });

  test("task promises from before the ledger are dropped when the database opens", () => {
    expect(legacyKinds).toEqual([{ kind: "block" }]);
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
    // At most six commands are outstanding per phone, so its sixteen-event outbox never drops one.
    const perTick = phone.settle(NIGHT, 4);
    expect(perTick.every((count) => count <= 6)).toBe(true);
    expect(phone.received).toHaveLength(17);
    expect(phone.received.every((command) => command.freeze.length === 1 && command.freeze[0]!.startsWith("^"))).toBe(true);
    expect([...phone.frozen.keys()].sort()).toEqual(NIGHT_PACKAGES.filter((name) => name !== "com.xingin.xhs").sort());

    // The report lists only eight, yet nothing is re-sent while the phone's own expiry holds.
    phone.received = [];
    expect(tick(new Date(NIGHT.getTime() + 5 * 60_000))).toEqual({ freeze_requests: 0, unfreeze_requests: 0 });
    // The missing app is not retried every minute.
    expect(phone.received).toHaveLength(0);

    phone.clearAtThree();
    phone.settle(AFTER_THREE, 4);
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
    // Results arrive asynchronously; the next tick takes them in.
    phone.settle(NIGHT, 4);
    const xhs = packageStates(PHONE).get("com.xingin.xhs")!;
    expect(Date.parse(xhs.retry_after) - NIGHT.getTime()).toBeGreaterThanOrEqual(59 * 60_000);
    phone.installed.add("com.xingin.xhs");
    phone.received = [];
    tick(new Date(NIGHT.getTime() + 61 * 60_000));
    expect(phone.received.map((command) => command.freeze[0])).toEqual(["^com\\.xingin\\.xhs$"]);
  });

  test("while anything is locked, a controller unfreeze only ever reaches the phone as exact unlocked names", () => {
    shopping();
    tick(NIGHT);
    const freeze = (name: string, say: string, id: string) =>
      sendDeviceCommands({ request_id: id, commands: [{ device_id: PHONE, freeze_commands: [name], say }] });
    freeze(GAME, "学习时间", "req_game");
    freeze("com.qidian.QDReader", "", "req_reader");
    phone.report({ reason: { [TAOBAO]: "购物先停一下" } });

    const send = (patterns: string[], id: string) => sendDeviceCommands({ request_id: id, commands: [{ device_id: PHONE, unfreeze_commands: patterns }] }).commands[0]!;
    const sentPatterns = (command: ReturnType<typeof send>) => (command.payload.payload as { unfreeze_commands: string[] }).unfreeze_commands;
    for (const alias of ["所有", "全量", "全部"]) {
      const sent = send([alias], `req_alias_${alias}`);
      expect(sentPatterns(sent).sort()).toEqual(["^com\\.qidian\\.QDReader$", "^com\\.ztgame\\.yyzy$"]);
      expect((sent.payload.payload as { notes: string[] }).notes).toContain("commitment_locked");
      freeze(GAME, "学习时间", `req_regame_${alias}`);
      freeze("com.qidian.QDReader", "", `req_rereader_${alias}`);
    }
    // Names, labels, the locked app's reason, and Java-only syntax JavaScript reads differently.
    for (const pattern of ["淘宝", "京东", "购物", TAOBAO, String.raw`淘\p{L}`, String.raw`t\x{61}obao`, String.raw`\b淘宝`, String.raw`t\0141obao`]) {
      const sent = send([pattern], `req_locked_${pattern}`);
      expect(sentPatterns(sent)).toEqual([]);
      expect(sent.delivery.status).toBe("skipped");
    }
    expect(phone.frozen.has(TAOBAO) && phone.frozen.has(JD)).toBe(true);

    // Unlocked apps still open, by name, group syntax, or the freeze reason Live learned from the command.
    expect(sentPatterns(send(["(?i:com\\.qidian)"], "req_group"))).toEqual(["^com\\.qidian\\.QDReader$"]);
    freeze("com.qidian.QDReader", "", "req_rereader_group");
    expect(sentPatterns(send(["学习时间"], "req_reason"))).toEqual(["^com\\.ztgame\\.yyzy$"]);
    const enforced = sendDeviceCommands({ request_id: "req_bypass", commands: [{ device_id: PHONE, unfreeze_commands: [TAOBAO] }] }, { bypassCommitments: true }).commands[0]!;
    expect(sentPatterns(enforced)).toEqual([TAOBAO]);
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

  test("a queued exception is kept if the phone runs it later and refunded if it never does", async () => {
    shopping();
    tick(NIGHT);
    const openCount = () => (db.prepare("SELECT COUNT(*) AS count FROM commitment_exceptions WHERE status = 'open'").get() as { count: number }).count;
    phone.disconnect();
    const queued = await requestExceptionUnfreeze({ device_id: PHONE, package_name: TAOBAO, purpose: "买药", minutes: 10 }, NIGHT);
    expect(queued).toMatchObject({ ok: true, results_pending: true });
    expect(openCount()).toBe(1);
    // The phone never fetched it: once the command expires the quota comes back.
    tick(new Date(NIGHT.getTime() + 11 * 60_000));
    expect(openCount()).toBe(0);

    const later = new Date(NIGHT.getTime() + 12 * 60_000);
    await requestExceptionUnfreeze({ device_id: PHONE, package_name: JD, purpose: "交电费", minutes: 10 }, later);
    // The phone fetches the queued command over HTTP and runs it.
    const row = db.prepare("SELECT payload FROM device_commands WHERE request_id LIKE 'commitment-exception-%' ORDER BY issued_at DESC LIMIT 1").get() as { payload: string };
    phone.receive(JSON.parse(row.payload));
    tick(new Date(later.getTime() + 60_000));
    expect(openCount()).toBe(1);
    expect(phone.frozen.has(JD)).toBe(false);

    phone.online = false;
    phone.report();
    await expect(requestExceptionUnfreeze({ device_id: PHONE, package_name: TAOBAO, purpose: "买药", minutes: 10 }, later))
      .rejects.toThrow("device_offline");
  });

  test("an exception the phone cannot apply is reported and refunded", async () => {
    phone.installed.add("com.xingin.xhs");
    night();
    phone.settle(NIGHT, 4);
    expect(phone.frozen.size).toBe(17);
    // The 17th record sits past the phone's 16-record unfreeze scan.
    const hidden = [...phone.frozen.keys()][16]!;
    await expect(requestExceptionUnfreeze({ device_id: PHONE, package_name: hidden, purpose: "查个东西", minutes: 5 }, NIGHT))
      .rejects.toThrow("exception_not_applied");
    expect(db.prepare("SELECT COUNT(*) AS count FROM commitment_exceptions WHERE status = 'open'").get()).toEqual({ count: 0 });
  });

  test("a freeze someone else placed is not lifted when the rule's window closes", () => {
    commitments.recordCommitment({
      title: "晚饭后", user_quote: "八点到十点不许购物", device_id: PHONE,
      packages: [TAOBAO, JD], window_start: "20:00", window_end: "22:00",
    }, RECORDED);
    // 19:00 local: a controller freezes Taobao until 03:00 on its own account.
    phone.now = new Date("2026-10-30T11:00:00.000Z");
    sendDeviceCommands({ request_id: "req_controller_freeze", commands: [{ device_id: PHONE, freeze_commands: [TAOBAO] }] });
    const evening = new Date("2026-10-30T12:30:00.000Z");
    tick(evening);
    tick(new Date(evening.getTime() + 60_000));
    expect(packageStates(PHONE).get(TAOBAO)?.owned).toBe(0);
    // 22:05 local: Live releases its own freeze of JD and leaves the controller's freeze alone.
    const closed = new Date("2026-10-30T14:05:00.000Z");
    for (let minute = 0; minute < 6; minute += 1) tick(new Date(closed.getTime() + minute * 60_000));
    expect([...phone.frozen.keys()]).toEqual([TAOBAO]);
  });

  test("a release the phone never answered is re-sent until it lands", () => {
    night();
    phone.settle(NIGHT, 4);
    phone.clearAtThree();
    phone.settle(AFTER_THREE, 4);
    phone.disconnect();
    for (let minute = 0; minute <= 40; minute += 5) tick(new Date(NOON.getTime() + minute * 60_000));
    expect(phone.frozen.size).toBe(16);
    expect([...packageStates(PHONE).values()].every((state) => state.release_attempts === 0)).toBe(true);
    phone.connect();
    for (let minute = 41; minute < 60; minute += 1) tick(new Date(NOON.getTime() + minute * 60_000));
    expect(phone.frozen.size).toBe(0);
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
