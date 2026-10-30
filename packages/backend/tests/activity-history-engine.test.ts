import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HistoryRow, HistoryWindow } from "../src/services/activity-history-engine";

const tempDir = mkdtempSync(join(tmpdir(), "live-history-engine-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

const base = Date.parse("2026-10-26T02:00:00.000Z");
let nextId = 1;

function row(minute: number, appId: string, appName = appId, title = "", matched = 1): HistoryRow {
  return {
    id: nextId++,
    started_at: new Date(base + minute * 60_000).toISOString(),
    app_id: appId,
    app_name: appName,
    display_title: title,
    matched,
  };
}

function window(startMinute: number, endMinute: number, nowMinute = 24 * 60): HistoryWindow {
  return {
    startMs: base + startMinute * 60_000,
    endMs: base + endMinute * 60_000,
    nowMs: base + nowMinute * 60_000,
  };
}

describe("activity history engine", () => {
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // The shared Bun test process may keep SQLite handles open briefly.
    }
  });

  test("counts the LSP five-minute heartbeat as continuous and credits one minute after a longer silence", async () => {
    const { foldDeviceHistory } = await import("../src/services/activity-history-engine");
    const segments = foldDeviceHistory("phone", [
      row(0, "com.qidian.QDReader", "起点读书"),
      row(5, "com.qidian.QDReader", "起点读书"),
      row(10, "com.qidian.QDReader", "起点读书"),
      row(17, "com.taobao.taobao", "淘宝"),
      row(19, "com.qidian.QDReader", "起点读书"),
    ], window(0, 60), false);

    expect(segments.map((segment) => segment.seconds)).toEqual([300, 300, 60, 120, 60]);
    // The last row has no successor inside the scan and the scan ends before now.
    expect(segments.at(-1)?.open).toBe(false);
  });

  test("marks idle and sleeping as away and splits sessions on app change or a 30-minute gap", async () => {
    const { foldDeviceHistory } = await import("../src/services/activity-history-engine");
    const segments = foldDeviceHistory("phone", [
      row(0, "com.qidian.QDReader", "起点读书"),
      row(5, "com.qidian.QDReader", "起点读书"),
      row(8, "idle"),
      row(9, "sleeping"),
      row(12, "com.qidian.QDReader", "起点读书"),
      row(50, "com.qidian.QDReader", "起点读书"),
    ], window(0, 60), false);

    expect(segments.map((segment) => segment.kind)).toEqual(["active", "active", "away", "away", "active", "active"]);
    expect(segments[2]?.matched).toBe(false);
    const sessions = segments.map((segment) => segment.session_id);
    expect(sessions[0]).toBe(sessions[1]);
    expect(new Set(sessions).size).toBe(5);
    expect(segments[5]?.session_start_ms).toBe(base + 50 * 60_000);
  });

  test("an open last row counts up to now; a stale one counts one minute", async () => {
    const { foldDeviceHistory } = await import("../src/services/activity-history-engine");
    const open = foldDeviceHistory("phone", [row(0, "a"), row(10, "b")], window(0, 14, 14), true);
    expect(open.at(-1)).toMatchObject({ open: true, seconds: 240 });

    const stale = foldDeviceHistory("phone", [row(0, "a"), row(10, "b")], window(0, 30, 30), true);
    expect(stale.at(-1)).toMatchObject({ open: false, seconds: 60 });
  });

  test("clips rows that straddle the window and leaves look-back rows only as neighbours", async () => {
    const { foldDeviceHistory } = await import("../src/services/activity-history-engine");
    const segments = foldDeviceHistory("phone", [
      row(-20, "a"),
      row(-3, "a"),
      row(2, "b"),
      row(9, "b"),
    ], window(0, 10), false);

    expect(segments.map((segment) => segment.seconds)).toEqual([0, 120, 60, 60]);
    // The session that began in the look-back keeps its real start.
    expect(segments[1]?.session_start_ms).toBe(base - 20 * 60_000);
  });
});
