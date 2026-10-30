import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-ledger-recall-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

const { db } = await import("../src/db");
const { openLedgerRecord, searchLedger, updateLedgerRecord } = await import("../src/services/ledger");

const NOW = new Date("2026-10-30T12:00:00.000Z");
const MINUTE = 60_000;

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

function words(text: string) {
  return { source: "his_words" as const, text, at: at(-MINUTE).toISOString() };
}

function liveData(text: string) {
  return { source: "live_data" as const, text, at: at(-MINUTE).toISOString() };
}

function idOf(result: unknown): string {
  return String((result as { record: { record_id: string } }).record.record_id);
}

function recall(about: string, extra: Record<string, unknown> = {}): string[] {
  const result = searchLedger({ about, ...extra }, at(2 * 60 * MINUTE)) as { records: Array<{ title: string }> };
  return result.records.map((record) => record.title);
}

describe("ledger recall by free text", () => {
  beforeEach(() => {
    db.run("DELETE FROM ledger_records");
  });
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite file locked until the process exits.
    }
  });

  function seedTonight(): void {
    openLedgerRecord({
      kind: "debt", subtype: "task", title: "补作业", detail: "今晚刷题两小时", evidence: [words("今晚我刷题两小时")],
    }, NOW);
    // Newer records that share only "今晚" with what he says next.
    openLedgerRecord({ kind: "debt", subtype: "task", title: "背单词", evidence: [words("今晚背完二十个单词")] }, at(MINUTE));
    openLedgerRecord({ kind: "hypothesis", subtype: "blocks", title: "睡前刷视频", evidence: [liveData("今晚 23:10 后打开抖音")] }, at(2 * MINUTE));
    openLedgerRecord({
      kind: "promise", title: "交物理卷子", evidence: [words("今晚十点前交物理卷子")], due_in_minutes: 300,
    }, at(3 * MINUTE));
  }

  test("a two-character word inside a sentence ranks its record first", () => {
    seedTonight();
    expect(recall("今晚还是先刷题吧，题目好多")).toEqual(["补作业"]);
    expect(recall("今晚还是先刷题吧", { limit: 1 })).toEqual(["补作业"]);
    // Other filters still apply.
    expect(recall("今晚还是先刷题吧", { kinds: ["promise"] })).toEqual([]);
    expect(() => searchLedger({ about: "刷题", cursor: "x" }, NOW)).toThrow("invalid_ledger_field");
  });

  test("unrelated text and filler words recall nothing", () => {
    seedTonight();
    expect(recall("外面下雨了，楼下的猫又跑出来")).toEqual([]);
    expect(recall("好的，我知道了，就是这样")).toEqual([]);
    expect(recall("ok on it")).toEqual([]);
    const result = searchLedger({ about: "外面下雨了" }, NOW);
    expect(result).toMatchObject({ records: [], next_cursor: null });
  });

  test("closed records rank after open ones, however well they match", () => {
    openLedgerRecord({ kind: "debt", subtype: "task", title: "补第三单元听写", evidence: [words("第三单元听写明天补")] }, NOW);
    const closedId = idOf(openLedgerRecord({
      kind: "promise", title: "背完第三单元单词", evidence: [words("一小时后背完第三单元单词")], due_in_minutes: 60,
    }, at(MINUTE)));
    updateLedgerRecord({
      record_id: closedId, outcome: "kept", add_evidence: [{ ...words("第三单元单词背完了，默写全对"), source: "his_submission" }],
    }, at(20 * MINUTE));

    expect(recall("第三单元的单词背完了")).toEqual(["补第三单元听写", "背完第三单元单词"]);
    expect(recall("第三单元的单词背完了", { status: "closed" })).toEqual(["背完第三单元单词"]);
  });
});
