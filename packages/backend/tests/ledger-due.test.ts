import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-ledger-due-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

const { db } = await import("../src/db");
const { openLedgerRecord, updateLedgerRecord } = await import("../src/services/ledger");
const { getLedgerRecord } = await import("../src/services/ledger-store");
const { queueDueLedgerWake } = await import("../src/services/ledger-due");
const { getSummarySettings, saveSummarySettings } = await import("../src/services/daily-summary-gen");
const { updateControllerPersona } = await import("../src/services/controller-persona");

const NOW = new Date("2026-10-30T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

function openPromise(quote: string, dueMinutes: number): string {
  const result = openLedgerRecord({
    kind: "promise",
    title: quote.slice(0, 20),
    evidence: [{ source: "his_words", text: quote, at: at(-MINUTE).toISOString() }],
    due_in_minutes: dueMinutes,
  }, NOW) as { record: { record_id: string } };
  return result.record.record_id;
}

function outboxEvents(): Array<{ event: Record<string, unknown>; created_at: string; expires_at: string }> {
  return (db.prepare("SELECT event_json, created_at, expires_at FROM controller_event_outbox ORDER BY created_at").all() as Array<{
    event_json: string;
    created_at: string;
    expires_at: string;
  }>).map((row) => ({ event: JSON.parse(row.event_json), created_at: row.created_at, expires_at: row.expires_at }));
}

describe("ledger due wake", () => {
  beforeEach(() => {
    process.env.HERMES_CONTROLLER_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_ENABLED = "true";
    saveSummarySettings({ ...getSummarySettings(), supervision_enabled: true });
    db.run("DELETE FROM ledger_records");
    db.run("DELETE FROM controller_event_outbox");
    db.run("DELETE FROM health_records");
  });
  afterAll(() => {
    delete process.env.HERMES_CONTROLLER_ENABLED;
    delete process.env.CONTROLLER_WEBHOOK_ENABLED;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite file locked until the process exits.
    }
  });

  test("a due promise queues one signed wake from the scheduler, once", () => {
    const id = openPromise("十分钟后发我听写", 10);
    expect(queueDueLedgerWake(at(9 * MINUTE))).toBe("idle");
    expect(outboxEvents()).toEqual([]);

    expect(queueDueLedgerWake(at(11 * MINUTE))).toBe("queued");
    const [queued] = outboxEvents();
    expect(queued!.event).toEqual({
      schema: "live_dashboard.controller_event.v1",
      v: 1,
      event_id: expect.stringMatching(/^ledger-due:[0-9a-f]{32}$/),
      event_type: "ledger.due",
      occurred_at: at(11 * MINUTE).toISOString(),
      source: "scheduled",
      device_ids: ["__server_scheduler__"],
      reason_codes: ["promise_due"],
    });
    expect(Date.parse(queued!.expires_at) - Date.parse(queued!.created_at)).toBe(2 * HOUR);
    expect(getLedgerRecord(id)!.due_notified_at).toBe(at(11 * MINUTE).toISOString());

    expect(queueDueLedgerWake(at(12 * MINUTE))).toBe("idle");
    expect(outboxEvents()).toHaveLength(1);
  });

  test("records due together share one wake with each kind's reason", () => {
    openPromise("二十分钟后交物理", 20);
    openLedgerRecord({
      kind: "debt", subtype: "task", title: "补单词",
      evidence: [{ source: "his_words", text: "昨天的单词二十分钟后补", at: at(-MINUTE).toISOString() }], due_in_minutes: 20,
    }, NOW);
    openLedgerRecord({
      kind: "state", subtype: "observation", title: "观察期",
      evidence: [{ source: "live_data", text: "刚对上一次谎", at: at(-MINUTE).toISOString() }], due_in_minutes: 15,
    }, NOW);
    expect(queueDueLedgerWake(at(21 * MINUTE))).toBe("queued");
    const events = outboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.event.reason_codes).toEqual(["promise_due", "debt_due", "state_end"]);
  });

  test("a closed gate leaves the record waiting instead of waking", () => {
    const id = openPromise("十分钟后发我听写", 10);
    const due = at(11 * MINUTE);
    const gates: Array<[string, () => void, () => void]> = [
      ["controller", () => { process.env.HERMES_CONTROLLER_ENABLED = "false"; }, () => { process.env.HERMES_CONTROLLER_ENABLED = "true"; }],
      ["webhook", () => { process.env.CONTROLLER_WEBHOOK_ENABLED = "false"; }, () => { process.env.CONTROLLER_WEBHOOK_ENABLED = "true"; }],
      ["supervision", () => saveSummarySettings({ ...getSummarySettings(), supervision_enabled: false }),
        () => saveSummarySettings({ ...getSummarySettings(), supervision_enabled: true })],
      ["paused persona", () => updateControllerPersona({ enabled: false }), () => updateControllerPersona({ enabled: true })],
      ["watch says asleep", () => {
        db.prepare(`
          INSERT INTO device_states (device_id, device_name, platform, app_id, app_name, window_title, display_title, last_seen_at, extra, is_online)
          VALUES ('watch', 'Watch', 'zepp', '', '', '', '', ?, '{}', 1)
          ON CONFLICT(device_id) DO NOTHING
        `).run(due.toISOString());
        db.prepare("INSERT INTO health_records (device_id, type, value, unit, recorded_at) VALUES ('watch', 'sleep_status', 1, '', ?)")
          .run(at(9 * MINUTE).toISOString());
      }, () => db.run("DELETE FROM health_records")],
    ];
    for (const [name, close, open] of gates) {
      close();
      expect({ name, result: queueDueLedgerWake(due) }).toEqual({ name, result: "gated" });
      expect(getLedgerRecord(id)!.due_notified_at).toBe("");
      open();
    }
    expect(outboxEvents()).toEqual([]);
    expect(queueDueLedgerWake(due)).toBe("queued");
  });

  test("a due time first seen hours late is marked without waking", () => {
    const id = openPromise("十分钟后发我听写", 10);
    expect(queueDueLedgerWake(at(10 * MINUTE + 3 * HOUR + MINUTE))).toBe("idle");
    expect(outboxEvents()).toEqual([]);
    expect(getLedgerRecord(id)!.due_notified_at).not.toBe("");
  });

  test("a moved due time wakes again under a new event id", () => {
    const id = openLedgerRecord({
      kind: "debt", subtype: "task", title: "补单词",
      evidence: [{ source: "his_words", text: "昨天的单词十分钟后补", at: at(-MINUTE).toISOString() }], due_in_minutes: 10,
    }, NOW) as { record: { record_id: string } };
    expect(queueDueLedgerWake(at(11 * MINUTE))).toBe("queued");
    updateLedgerRecord({ record_id: id.record.record_id, due_in_minutes: 30 }, at(12 * MINUTE));
    expect(queueDueLedgerWake(at(20 * MINUTE))).toBe("idle");
    expect(queueDueLedgerWake(at(43 * MINUTE))).toBe("queued");
    const ids = outboxEvents().map((row) => row.event.event_id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
