import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-summary-scheduler-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

describe("summary scheduler", () => {
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // SQLite handles may still be open at process shutdown.
    }
  });

  test("uses the saved client timezone and catches missed exact minutes", async () => {
    const { getSummarySettings } = await import("../src/services/daily-summary-gen");
    const { collectDueSummaryJobs, initialSummaryScheduleState } = await import("../src/services/summary-scheduler");
    const settings = {
      ...getSummarySettings(),
      daily_summary_time: "21:00",
      weekly_summary_weekday: 5,
      weekly_summary_time: "21:30",
      timezone_offset_minutes: -480,
    };

    const before = collectDueSummaryJobs(
      new Date("2026-07-03T12:59:00.000Z"),
      settings,
      initialSummaryScheduleState(),
    );
    expect(before.jobs).toEqual([]);

    const after = collectDueSummaryJobs(
      new Date("2026-07-03T13:01:00.000Z"),
      settings,
      initialSummaryScheduleState(),
    );
    expect(after.jobs).toEqual([{ kind: "daily", date: "2026-07-03", tzOffsetMinutes: -480 }]);

    const duplicate = collectDueSummaryJobs(
      new Date("2026-07-03T13:05:00.000Z"),
      settings,
      after.state,
    );
    expect(duplicate.jobs).toEqual([]);

    const weekly = collectDueSummaryJobs(
      new Date("2026-07-03T13:31:00.000Z"),
      settings,
      duplicate.state,
    );
    expect(weekly.jobs).toEqual([{ kind: "weekly", date: "2026-07-03", weekStart: "2026-06-29", tzOffsetMinutes: -480 }]);
  });

  test("keeps Live AI scheduling in standby while Hermes controls the service", async () => {
    const { getSummarySettings } = await import("../src/services/daily-summary-gen");
    const { collectDueSummaryJobs, initialSummaryScheduleState } = await import("../src/services/summary-scheduler");
    const settings = {
      ...getSummarySettings(),
      daily_summary_time: "21:00",
      weekly_summary_weekday: 5,
      weekly_summary_time: "21:30",
      timezone_offset_minutes: -480,
    };
    const initial = initialSummaryScheduleState();
    process.env.HERMES_CONTROLLER_ENABLED = "true";
    try {
      const controlled = collectDueSummaryJobs(new Date("2026-07-03T13:31:00.000Z"), settings, initial);
      expect(controlled).toEqual({ jobs: [], state: initial });
    } finally {
      delete process.env.HERMES_CONTROLLER_ENABLED;
    }

    process.env.HERMES_CONTROLLER_ENABLED = "1";
    try {
      const fallback = collectDueSummaryJobs(new Date("2026-07-03T13:31:00.000Z"), settings, initial);
      expect(fallback.jobs).toEqual([
        { kind: "daily", date: "2026-07-03", tzOffsetMinutes: -480 },
        { kind: "weekly", date: "2026-07-03", weekStart: "2026-06-29", tzOffsetMinutes: -480 },
      ]);
    } finally {
      delete process.env.HERMES_CONTROLLER_ENABLED;
    }
  });
});
