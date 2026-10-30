import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-controller-context-enforcement-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

const { db } = await import("../src/db");
const { getControllerContext } = await import("../src/services/controller-context");

const insertCommand = db.prepare(`
  INSERT INTO device_commands (
    command_id, request_id, target_device_id, message_id, kind, payload, issued_at, expires_at,
    created_by, delivery_status, result_status
  ) VALUES (?, ?, 'phone', ?, ?, ?, ?, ?, ?, ?, ?)
`);

function command(input: {
  at: string;
  requestId?: string;
  createdBy?: "mcp" | "supervision";
  kind?: string;
  payload: Record<string, unknown>;
  delivery?: string;
  result?: string;
}): void {
  const commandId = `cmd_${crypto.randomUUID()}`;
  const envelope = {
    type: "device_command",
    v: 1,
    command_id: commandId,
    payload: { kind: input.kind ?? "supervision", freeze_commands: [], unfreeze_commands: [], vibrate: false, screen_off: false, say: "", notes: [], ...input.payload },
  };
  insertCommand.run(
    commandId,
    input.requestId ?? `req_${crypto.randomUUID()}`,
    commandId,
    input.kind ?? "supervision",
    JSON.stringify(envelope),
    input.at,
    new Date(Date.parse(input.at) + 600_000).toISOString(),
    input.createdBy ?? "mcp",
    input.delivery ?? "sent",
    input.result ?? "applied",
  );
}

// 2026-09-02 in UTC+08:00 runs from 2026-09-01T16:00Z to 2026-09-02T16:00Z.
command({ at: "2026-09-02T02:00:00.000Z", payload: { say: "该回去写论文了", vibrate: true } });
command({ at: "2026-09-02T03:00:00.000Z", payload: { freeze_commands: ["^com\\.tencent\\.mm$"] } });
command({
  at: "2026-09-02T03:30:00.000Z",
  payload: { notes: ["freeze_disabled_by_user"] },
  delivery: "skipped",
  result: "ignored",
});
command({
  at: "2026-09-02T04:00:00.000Z",
  requestId: `commitment-sync-${crypto.randomUUID()}`,
  createdBy: "supervision",
  payload: { freeze_commands: ["^com\\.taobao\\.taobao$"] },
});
command({
  at: "2026-09-02T05:00:00.000Z",
  requestId: `commitment-exception-${crypto.randomUUID()}`,
  createdBy: "supervision",
  payload: { unfreeze_commands: ["^com\\.taobao\\.taobao$"] },
  result: "unknown",
});
command({ at: "2026-09-02T06:00:00.000Z", kind: "supervision_policy", payload: { risk_app_regex: ["game"] } });
command({ at: "2026-09-02T07:00:00.000Z", payload: {} });
command({ at: "2026-09-02T20:00:00.000Z", payload: { say: "第二天的提醒" } });

describe("enforcement in daily and weekly controller contexts", () => {
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite file locked until the process exits.
    }
  });

  test("a daily context lists the day's reminders, freezes, and rule enforcement", () => {
    const context = getControllerContext({ mode: "daily", date: "2026-09-02", timezone_offset_minutes: -480 });
    const enforcement = context.enforcement as {
      range: { start: string; end: string };
      totals: Record<string, Record<string, number>>;
      command_count: number;
      truncated: boolean;
      commands: Array<Record<string, unknown>>;
    };

    expect(enforcement.range).toEqual({ start: "2026-09-01T16:00:00.000Z", end: "2026-09-02T16:00:00.000Z" });
    expect(enforcement.command_count).toBe(5);
    expect(enforcement.truncated).toBe(false);
    expect(enforcement.commands).toEqual([
      { at: "2026-09-02T02:00:00.000Z", device_id: "phone", source: "controller", say: "该回去写论文了", vibrate: true, result: "applied" },
      { at: "2026-09-02T03:00:00.000Z", device_id: "phone", source: "controller", freeze: ["com.tencent.mm"], result: "applied" },
      { at: "2026-09-02T03:30:00.000Z", device_id: "phone", source: "controller", notes: ["freeze_disabled_by_user"], result: "skipped" },
      { at: "2026-09-02T04:00:00.000Z", device_id: "phone", source: "rule_enforcement", freeze: ["com.taobao.taobao"], result: "applied" },
      { at: "2026-09-02T05:00:00.000Z", device_id: "phone", source: "rule_enforcement", exception: true, unfreeze: ["com.taobao.taobao"], result: "timeout" },
    ]);
    expect(enforcement.totals).toEqual({
      controller: { commands: 3, say: 1, vibrate: 1, screen_off: 0, freeze: 1, unfreeze: 0, applied: 2 },
      rule_enforcement: { commands: 2, say: 0, vibrate: 0, screen_off: 0, freeze: 1, unfreeze: 1, applied: 1 },
    });
  });

  test("a weekly context covers the whole week; action modes leave the section out", () => {
    const weekly = getControllerContext({ mode: "weekly", week_start: "2026-08-31", timezone_offset_minutes: -480 });
    expect((weekly.enforcement as { command_count: number }).command_count).toBe(6);
    expect(getControllerContext({ mode: "supervision" })).not.toHaveProperty("enforcement");
    expect(getControllerContext({ mode: "companion" })).not.toHaveProperty("enforcement");
  });
});
