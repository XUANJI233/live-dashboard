import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-ledger-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

const { db } = await import("../src/db");
const { maintainLedger, openLedgerRecord, searchLedger, updateLedgerRecord, ledgerTrack } = await import("../src/services/ledger");
const { getLedgerRecord } = await import("../src/services/ledger-store");

const NOW = new Date("2026-10-30T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

function words(text: string, when = at(-MINUTE)) {
  return { source: "his_words" as const, text, at: when.toISOString() };
}

function submission(text: string, when = at(-MINUTE)) {
  return { source: "his_submission" as const, text, at: when.toISOString() };
}

function liveData(text: string, ref?: string) {
  return { source: "live_data" as const, text, at: at(-MINUTE).toISOString(), ...(ref ? { ref } : {}) };
}

function promise(quote = "四十分钟后给我第二章", extra: Record<string, unknown> = {}, now = NOW) {
  return openLedgerRecord({
    kind: "promise",
    title: "第二章",
    detail: "第二章习题全部做完拍照",
    evidence: [words(quote, new Date(now.getTime() - MINUTE))],
    due_in_minutes: 40,
    ...extra,
  }, now) as { record: Record<string, unknown>; duplicate?: boolean };
}

function idOf(result: unknown): string {
  return String((result as { record: { record_id: string } }).record.record_id);
}

describe("supervision ledger", () => {
  beforeEach(() => {
    db.run("DELETE FROM ledger_records");
    db.run("DELETE FROM visitor_messages");
  });
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite file locked until the process exits.
    }
  });

  test("a promise from his words stores its due time, and the same words again return it", () => {
    const first = promise();
    expect(first.record).toMatchObject({
      kind: "promise",
      status: "open",
      due_at: at(40 * MINUTE).toISOString(),
      evidence_count: 1,
    });
    expect(first.duplicate).toBeUndefined();

    // A cron lane quoting the same message minutes later, with its own wording of the title.
    const again = openLedgerRecord({
      kind: "promise",
      title: "交第二章",
      evidence: [words("四十分钟后给我第二章")],
      due_in_minutes: 35,
    }, at(5 * MINUTE)) as { record: { record_id: string }; duplicate?: boolean };
    expect(again).toMatchObject({ duplicate: true, record: { record_id: idOf(first) } });
    expect(db.prepare("SELECT COUNT(*) AS count FROM ledger_records").get()).toEqual({ count: 1 });
  });

  test("each kind keeps its own shape", () => {
    const base = { title: "x", evidence: [words("我保证今晚做完")] };
    expect(() => openLedgerRecord({ ...base, kind: "promise" }, NOW)).toThrow("ledger_due_required");
    expect(() => openLedgerRecord({ ...base, kind: "promise", due_in_minutes: 8 * 24 * 60 }, NOW)).toThrow("invalid_ledger_due");
    expect(() => openLedgerRecord({ ...base, kind: "promise", due_at: "2026-10-30T23:00:00" }, NOW)).toThrow("invalid_ledger_due");
    expect(() => openLedgerRecord({ ...base, kind: "promise", due_in_minutes: 30, due_at: "2026-10-30T23:00:00+08:00" }, NOW))
      .toThrow("invalid_ledger_due");
    expect(() => openLedgerRecord({ ...base, kind: "promise", subtype: "task", due_in_minutes: 30 }, NOW)).toThrow("invalid_ledger_subtype");
    expect(() => openLedgerRecord({ ...base, kind: "debt" }, NOW)).toThrow("invalid_ledger_subtype");
    expect(() => openLedgerRecord({ ...base, kind: "breach", subtype: "lie" }, NOW)).toThrow("invalid_ledger_subtype");
    expect(() => openLedgerRecord({ ...base, kind: "hypothesis", subtype: "helps", due_in_minutes: 30 }, NOW)).toThrow("invalid_ledger_due");
    expect(() => openLedgerRecord({ ...base, kind: "hypothesis", subtype: "helps", stake: "罚抄" }, NOW)).toThrow("invalid_ledger_field");
    expect(() => openLedgerRecord({ ...base, kind: "debt", subtype: "task", confidence: "high" }, NOW)).toThrow("invalid_ledger_field");
    expect(() => openLedgerRecord({ ...base, kind: "state", subtype: "observation" }, NOW)).toThrow("ledger_due_required");
    expect(() => openLedgerRecord({ ...base, kind: "promise", due_in_minutes: 30, evidence: [liveData("用量记录")] }, NOW))
      .toThrow("ledger_his_words_required");
    // A false claim is confirmed by something other than what he said.
    expect(() => openLedgerRecord({ ...base, kind: "breach", subtype: "false_claim" }, NOW)).toThrow("ledger_evidence_required");
    expect(() => openLedgerRecord({ ...base, kind: "debt", subtype: "task", evidence: [words("欠着的", at(-31 * DAY))] }, NOW))
      .toThrow("ledger_evidence_time_invalid");
    expect(() => openLedgerRecord({
      ...base, kind: "debt", subtype: "task", evidence: [{ ...words("欠着的"), at: "2026-10-30T19:00:00" }],
    }, NOW)).toThrow("ledger_evidence_time_invalid");
    expect(() => openLedgerRecord({ ...base, kind: "promise", due_in_minutes: 30, parent_id: `led_${crypto.randomUUID()}` }, NOW))
      .toThrow("ledger_record_not_found");

    const breach = openLedgerRecord({
      kind: "breach",
      subtype: "false_claim",
      title: "说在写作业，其实在刷视频",
      evidence: [words("我一直在写作业"), liveData("手机 20:00-20:45 哔哩哔哩 41 分钟", "android-phone 20:00-20:45")],
    }, NOW);
    expect(breach).toMatchObject({ record: { kind: "breach", subtype: "false_claim", evidence_count: 2 } });
    const hypothesis = openLedgerRecord({
      kind: "hypothesis", subtype: "blocks", title: "晚饭后先刷手机就很难开始", evidence: [liveData("三晚都在 19:30 后打开抖音")],
    }, NOW);
    expect(hypothesis).toMatchObject({ record: { confidence: "low" } });
  });

  test("open records are capped per kind", () => {
    for (let index = 0; index < 12; index += 1) promise(`第${index}个承诺，今晚交`);
    expect(() => promise("第十三个承诺，今晚交")).toThrow("ledger_kind_full");
  });

  test("health details, private identifiers and visitors' words never enter the ledger", () => {
    expect(() => promise("吃了托莫西汀以后四十分钟交")).toThrow("health_detail_rejected");
    expect(() => promise("四十分钟后给我", { detail: "他说确诊以后会好" })).toThrow("health_detail_rejected");
    expect(() => promise("交完发到 13800138000")).toThrow("private_detail_rejected");
    expect(() => promise("交完发到 someone@example.com")).toThrow("private_detail_rejected");

    const insert = db.prepare(`
      INSERT INTO visitor_messages (id, device_id, viewer_id, viewer_name, kind, direction, text, created_at)
      VALUES (?, 'android-phone', ?, 'v', ?, ?, ?, ?)
    `);
    insert.run("m1", "viewer-1", "public", "viewer", "哈哈他说今晚十点前交物理卷子", at(-HOUR).toISOString());
    insert.run("m2", "__public__", "reply", "device", "明天早上八点前背完单词", at(-HOUR).toISOString());
    expect(() => promise("今晚十点前交物理卷子")).toThrow("quote_not_his_words");
    // His own replies on the page and short quotes are not checked against visitors.
    expect(promise("明天早上八点前背完单词").record).toMatchObject({ status: "open" });
    insert.run("m3", "viewer-2", "private", "viewer", "好的", at(-HOUR).toISOString());
    expect(promise("好的").record).toMatchObject({ status: "open" });
  });

  test("closing needs the evidence its outcome claims", () => {
    const id = idOf(promise());
    expect(() => updateLedgerRecord({ record_id: id, outcome: "kept", add_evidence: [words("做完了")] }, at(30 * MINUTE)))
      .toThrow("ledger_evidence_required");
    expect(() => updateLedgerRecord({ record_id: id, outcome: "resolved" }, at(30 * MINUTE))).toThrow("invalid_ledger_outcome");
    expect(() => updateLedgerRecord({ record_id: id, outcome: "waived" }, at(30 * MINUTE))).toThrow("ledger_note_required");
    expect(() => updateLedgerRecord({ record_id: id, outcome: "broken" }, at(30 * MINUTE))).toThrow("ledger_evidence_required");
    expect(() => updateLedgerRecord({ record_id: id, note: "x" }, at(30 * MINUTE))).toThrow("invalid_ledger_field");

    const kept = updateLedgerRecord({
      record_id: id, outcome: "kept", add_evidence: [submission("第二章十二道题的照片，全部看过")],
    }, at(30 * MINUTE));
    expect(kept).toMatchObject({ record: { status: "closed", outcome: "kept", evidence_count: 2 } });
    expect(ledgerTrack(at(31 * MINUTE))).toMatchObject({ kept_streak: 1, kept_7d: 1, broken_7d: 0 });
    // Another lane closing it the same way gets the same answer; a different outcome is refused.
    expect(updateLedgerRecord({ record_id: id, outcome: "kept" }, at(32 * MINUTE))).toMatchObject({ duplicate: true });
    expect(() => updateLedgerRecord({ record_id: id, outcome: "broken" }, at(32 * MINUTE))).toThrow("ledger_record_closed");
  });

  test("a broken promise with a stake opens its consequence once", () => {
    const id = idOf(promise("四十分钟后给我第二章，没交就罚抄", { stake: "罚抄第二章公式三遍" }));
    const afterDue = at(45 * MINUTE);
    expect(() => updateLedgerRecord({ record_id: id, outcome: "cancelled", note: "他说不做了" }, afterDue))
      .toThrow("ledger_due_passed");

    const broken = updateLedgerRecord({ record_id: id, outcome: "broken" }, afterDue) as {
      record: Record<string, unknown>;
      opened: Array<Record<string, unknown>>;
    };
    expect(broken.record).toMatchObject({ status: "closed", outcome: "broken" });
    expect(broken.opened).toHaveLength(1);
    expect(broken.opened[0]).toMatchObject({ kind: "debt", subtype: "consequence", title: "罚抄第二章公式三遍", parent_id: id });

    const again = updateLedgerRecord({ record_id: id, outcome: "broken" }, at(50 * MINUTE));
    expect(again).toMatchObject({ duplicate: true });
    expect(again).not.toHaveProperty("opened");
    expect(db.prepare("SELECT COUNT(*) AS count FROM ledger_records WHERE kind = 'debt'").get()).toEqual({ count: 1 });
    expect(ledgerTrack(afterDue)).toMatchObject({ kept_streak: 0, broken_7d: 1 });
  });

  test("updates follow the record's rules", () => {
    const promiseId = idOf(promise());
    expect(() => updateLedgerRecord({ record_id: promiseId, due_in_minutes: 60 }, at(10 * MINUTE))).toThrow("ledger_his_words_required");
    const moved = updateLedgerRecord({
      record_id: promiseId, due_in_minutes: 60, add_evidence: [words("再给我一个小时", at(9 * MINUTE))],
    }, at(10 * MINUTE));
    expect(moved).toMatchObject({ record: { due_at: at(70 * MINUTE).toISOString() } });
    expect(() => updateLedgerRecord({
      record_id: promiseId, due_in_minutes: 60, add_evidence: [words("再给我一个小时吧", at(80 * MINUTE))],
    }, at(80 * MINUTE))).toThrow("ledger_due_passed");

    const debt = openLedgerRecord({
      kind: "debt", subtype: "task", title: "补昨天的单词", evidence: [words("昨天的单词我明天补")], due_in_minutes: 30,
    }, NOW);
    const debtId = idOf(debt);
    db.prepare("UPDATE ledger_records SET due_notified_at = ? WHERE record_id = ?").run(at(31 * MINUTE).toISOString(), debtId);
    updateLedgerRecord({ record_id: debtId, due_in_minutes: 120 }, at(40 * MINUTE));
    expect(getLedgerRecord(debtId)!.due_notified_at).toBe("");

    const hypothesisId = idOf(openLedgerRecord({
      kind: "hypothesis", subtype: "helps", title: "先做最短的一题能让他开始", evidence: [liveData("两次都先做了选择题")],
    }, NOW));
    expect(() => updateLedgerRecord({ record_id: hypothesisId, confidence: "medium" }, NOW)).toThrow("ledger_evidence_required");
    expect(updateLedgerRecord({
      record_id: hypothesisId, confidence: "medium", add_evidence: [liveData("第三次也是")],
    }, NOW)).toMatchObject({ record: { confidence: "medium" } });
    expect(updateLedgerRecord({ record_id: hypothesisId, confidence: "low" }, NOW)).toMatchObject({ record: { confidence: "low" } });
    expect(() => updateLedgerRecord({ record_id: hypothesisId, confidence: "low" }, NOW)).toThrow("ledger_nothing_to_update");
    expect(() => updateLedgerRecord({ record_id: hypothesisId, stake: "罚抄" }, NOW)).toThrow("invalid_ledger_field");
    for (let index = 0; index < 6; index += 1) {
      updateLedgerRecord({ record_id: hypothesisId, add_evidence: [liveData(`第${index}次观察`)] }, NOW);
    }
    expect(() => updateLedgerRecord({ record_id: hypothesisId, add_evidence: [liveData("再一次")] }, NOW)).toThrow("ledger_evidence_full");
    expect(() => updateLedgerRecord({ record_id: `led_${crypto.randomUUID()}`, outcome: "retired" }, NOW)).toThrow("ledger_record_not_found");
  });

  test("search finds Chinese words inside sentences, filters, and pages with a cursor", () => {
    openLedgerRecord({ kind: "debt", subtype: "task", title: "补作业", detail: "今晚刷题两小时，100% 完成", evidence: [words("今晚我刷题两小时")] }, NOW);
    openLedgerRecord({ kind: "debt", subtype: "consequence", title: "周末不碰游戏", evidence: [words("再拖就周末不碰游戏")] }, at(MINUTE));
    const closedId = idOf(promise("十点前背完 a_b 单元"));
    updateLedgerRecord({ record_id: closedId, outcome: "kept", add_evidence: [submission("单元默写全对")] }, at(20 * MINUTE));

    const titles = (input: Parameters<typeof searchLedger>[0]) =>
      ((searchLedger(input, at(HOUR)).records) as Array<{ title: string }>).map((record) => record.title);
    expect(titles({ query: "刷题" })).toEqual(["补作业"]);
    expect(titles({ query: "100%" })).toEqual(["补作业"]);
    expect(titles({ query: "%" })).toEqual(["补作业"]);
    expect(titles({ query: "a_b" })).toEqual(["第二章"]);
    expect(titles({ query: "ab" })).toEqual([]);
    expect(titles({ query: "默写" })).toEqual(["第二章"]);
    expect(titles({ kinds: ["debt"], status: "open" })).toEqual(["周末不碰游戏", "补作业"]);
    expect(titles({ outcome: "kept" })).toEqual(["第二章"]);
    expect(titles({ time_field: "due", from: NOW.toISOString(), to: at(HOUR).toISOString() })).toEqual(["第二章"]);
    expect(titles({ time_field: "closed", from: at(10 * MINUTE).toISOString() })).toEqual(["第二章"]);

    const withEvidence = searchLedger({ query: "默写", include_evidence: true }, at(HOUR)).records as Array<Record<string, unknown>>;
    expect(withEvidence[0]!.evidence).toEqual([
      expect.objectContaining({ role: "basis", source: "his_words" }),
      expect.objectContaining({ role: "settlement", source: "his_submission", text: "单元默写全对" }),
    ]);
    const withoutEvidence = searchLedger({ query: "默写" }, at(HOUR)).records as Array<Record<string, unknown>>;
    expect(withoutEvidence[0]).not.toHaveProperty("evidence");
    expect(() => searchLedger({ cursor: "not-a-cursor" }, NOW)).toThrow("invalid_cursor");
  });

  test("the cursor walks every record once", () => {
    // Every third record shares one creation time, so the record id has to break the tie.
    for (let index = 0; index < 25; index += 1) {
      const id = idOf(openLedgerRecord({
        kind: "hypothesis", subtype: "helps", title: `第${index}条`, evidence: [liveData(`观察 ${index}`)],
      }, at(index % 3 === 0 ? 0 : index * MINUTE)));
      updateLedgerRecord({ record_id: id, outcome: "retired" }, at(index * MINUTE));
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = searchLedger({ limit: 7, ...(cursor ? { cursor } : {}) }, at(HOUR)) as {
        records: Array<{ record_id: string }>;
        next_cursor: string | null;
      };
      seen.push(...page.records.map((record) => record.record_id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    const all = db.prepare("SELECT record_id FROM ledger_records").all() as Array<{ record_id: string }>;
    expect(seen).toHaveLength(all.length);
    expect(new Set(seen).size).toBe(all.length);
  });

  test("Live's own clocks close what nobody closed, then delete old history", () => {
    const promiseId = idOf(promise());
    const undatedDebt = idOf(openLedgerRecord({ kind: "debt", subtype: "consequence", title: "罚抄", evidence: [words("没交就罚抄")] }, NOW));
    const state = idOf(openLedgerRecord({
      kind: "state", subtype: "observation", title: "观察期", evidence: [liveData("刚对上一次谎")], due_in_minutes: 7 * 24 * 60,
    }, NOW));
    const breach = idOf(openLedgerRecord({
      kind: "breach", subtype: "bypass", title: "绕过冻结", evidence: [liveData("冻结期间用了网页版")],
    }, NOW));
    const hypothesis = idOf(openLedgerRecord({
      kind: "hypothesis", subtype: "blocks", title: "睡前刷手机", evidence: [liveData("连续三晚")],
    }, NOW));
    const outcome = (id: string) => getLedgerRecord(id)?.outcome;

    maintainLedger(at(40 * MINUTE + 47 * HOUR));
    expect(outcome(promiseId)).toBe("");
    maintainLedger(at(40 * MINUTE + 48 * HOUR));
    expect(outcome(promiseId)).toBe("lapsed");
    expect(ledgerTrack(at(3 * DAY))).toMatchObject({ kept_streak: 0, kept_7d: 0, broken_7d: 0 });

    maintainLedger(at(8 * DAY - MINUTE));
    expect(outcome(state)).toBe("");
    maintainLedger(at(8 * DAY));
    expect(outcome(state)).toBe("ended");

    maintainLedger(at(30 * DAY));
    expect([outcome(undatedDebt), outcome(breach), outcome(hypothesis)]).toEqual(["lapsed", "faded", "stale"]);

    // Closed records are kept 180 days: first the two closed early, then the three closed at day 30.
    expect(maintainLedger(at(210 * DAY - MINUTE)).pruned).toBe(2);
    expect(maintainLedger(at(210 * DAY)).pruned).toBe(3);
    expect(db.prepare("SELECT COUNT(*) AS count FROM ledger_records").get()).toEqual({ count: 0 });
  });
});
