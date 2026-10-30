import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-ledger-context-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

const { db } = await import("../src/db");
const { openLedgerRecord, updateLedgerRecord } = await import("../src/services/ledger");
const { ledgerContext } = await import("../src/services/ledger-context");
const { LEDGER_SECTION_MAX_BYTES } = await import("../src/services/ledger-context-trim");
const { getControllerContext } = await import("../src/services/controller-context");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const RANGE = { start: "2026-10-29T16:00:00.000Z", end: "2026-10-30T16:00:00.000Z" };
const NOW = new Date("2026-10-30T12:00:00.000Z");

function evidence(text: string, now: Date, source: "his_words" | "live_data" = "his_words") {
  return [{ source, text, at: new Date(now.getTime() - MINUTE).toISOString() }];
}

function promiseAt(openedAt: Date, quote: string, dueMinutes: number, extra: Record<string, unknown> = {}): string {
  const result = openLedgerRecord({
    kind: "promise", title: quote.slice(0, 20), evidence: evidence(quote, openedAt), due_in_minutes: dueMinutes, ...extra,
  }, openedAt) as { record: { record_id: string } };
  return result.record.record_id;
}

function section(mode: string, now = NOW): Record<string, any> {
  return ledgerContext({ mode, range: RANGE, timezoneOffset: -480, now }).section as Record<string, any>;
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

describe("ledger context section", () => {
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

  test("lists what is due oldest first, then what is open, within each mode's limits", () => {
    const opened = new Date(NOW.getTime() - 2 * HOUR);
    const late = promiseAt(opened, "一小时内交英语作文", 60, { stake: "周末少玩一小时" });
    const later = promiseAt(opened, "一个半小时内交数学卷子", 90);
    for (let index = 0; index < 6; index += 1) promiseAt(NOW, `第${index}件事，晚点交`, 30 + index * 10);
    for (let index = 0; index < 4; index += 1) {
      openLedgerRecord({
        kind: "hypothesis", subtype: "helps", title: `假设${index}`, evidence: evidence(`观察${index}`, NOW, "live_data"),
        confidence: index === 2 ? "high" : "low",
      }, NOW);
    }

    const supervision = section("supervision");
    expect(supervision.due_now.map((item: { record_id: string }) => item.record_id)).toEqual([late, later]);
    expect(supervision.due_now[0]).toMatchObject({ kind: "promise", stake: "周末少玩一小时", overdue_minutes: 60, due_local: "2026-10-30 19:00" });
    expect(supervision.open).toHaveLength(4);
    expect(supervision.open[0].title).toBe("第0件事，晚点交");
    expect(supervision.hypotheses).toHaveLength(2);
    expect(supervision.hypotheses[0]).toMatchObject({ title: "假设2", confidence: "high" });
    expect(supervision.counts).toEqual({ due: 2, open: 6, breaches: 0, hypotheses: 4 });
    expect(supervision).not.toHaveProperty("closed_in_range");

    expect(section("companion").open).toHaveLength(6);
    expect(section("companion").hypotheses).toHaveLength(3);
    expect(ledgerContext({ mode: "memory", range: RANGE, timezoneOffset: -480, now: NOW })).toEqual({ section: null, truncated: false });
  });

  test("daily mode adds what closed in its range and the kept/broken track", () => {
    const id = promiseAt(NOW, "半小时后交物理", 30);
    updateLedgerRecord({
      record_id: id, outcome: "kept",
      add_evidence: [{ source: "his_submission", text: "物理卷子照片，看过", at: NOW.toISOString() }],
    }, new Date(NOW.getTime() + 20 * MINUTE));
    const daily = section("daily", new Date(NOW.getTime() + HOUR));
    expect(daily.closed_in_range).toEqual([{ record_id: id, kind: "promise", title: "半小时后交物理", outcome: "kept" }]);
    expect(daily.track).toMatchObject({ kept_streak: 1, kept_7d: 1, broken_7d: 0, last_broken_local: null });
  });

  test("a full ledger of maximum-length records stays under its byte cap and keeps every due record", () => {
    const long = (label: string, length: number) => `${label}${"很长的说明".repeat(80)}`.slice(0, length);
    const opened = new Date(NOW.getTime() - 3 * HOUR);
    const due: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      due.push(promiseAt(opened, `${index}号到点的承诺原话`, 60 + index, {
        title: long(`到点${index}`, 60), detail: long(`细节${index}`, 300), stake: long(`后果${index}`, 120),
      }));
    }
    for (let index = 0; index < 12; index += 1) {
      openLedgerRecord({
        kind: "debt", subtype: "task", title: long(`欠${index}`, 60), detail: long("x", 300), stake: long("y", 120),
        evidence: evidence(`欠着的第${index}件`, NOW), due_in_minutes: 600,
      }, NOW);
      openLedgerRecord({
        kind: "breach", subtype: "bypass", title: long(`绕过${index}`, 60), evidence: evidence(`冻结期间第${index}次`, NOW, "live_data"),
      }, NOW);
      openLedgerRecord({
        kind: "hypothesis", subtype: "blocks", title: long(`假设${index}`, 60), evidence: evidence(`看到第${index}次`, NOW, "live_data"),
      }, NOW);
    }

    const result = ledgerContext({ mode: "daily", range: RANGE, timezoneOffset: -480, now: NOW });
    expect(result.truncated).toBe(true);
    expect(bytes(result.section)).toBeLessThanOrEqual(LEDGER_SECTION_MAX_BYTES);
    expect((result.section!.due_now as Array<{ record_id: string }>).map((item) => item.record_id)).toEqual(due);
    expect(result.section!.counts).toEqual({ due: 8, open: 12, breaches: 12, hypotheses: 12 });
  });

  test("get_controller_context carries the section in every mode but memory", () => {
    promiseAt(new Date(Date.now() - 2 * HOUR), "一小时内交英语作文", 60);
    for (const mode of ["supervision", "policy", "companion", "followup", "daily", "weekly"] as const) {
      const context = getControllerContext({ mode });
      expect({ mode, due: (context.ledger as { due_now: unknown[] } | undefined)?.due_now.length }).toEqual({ mode, due: 1 });
    }
    expect(getControllerContext({ mode: "memory" })).not.toHaveProperty("ledger");
  });
});
