import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-device-command-boundaries-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

const { db } = await import("../src/db");
const { sendDeviceCommands } = await import("../src/services/device-control");
const { getSummarySettings, saveSummarySettings } = await import("../src/services/daily-summary-gen");

const DEVICE_ID = "android-lsp-boundaries";
db.prepare(`
  INSERT OR REPLACE INTO device_states (
    device_id, device_name, platform, app_id, app_name, window_title, display_title,
    last_seen_at, extra, is_online
  ) VALUES (?, 'Boundary Phone', 'android', 'com.example.current', 'Current App', '', 'Current App',
    datetime('now'), ?, 1)
`).run(DEVICE_ID, JSON.stringify({
  device: {
    profile: "android_lsp",
    capabilities: { freeze: true, unfreeze: true, vibrate: true, screen_off: true, say: true },
  },
}));

function setSwitches(enabled: boolean, lspFreeze: boolean, vibrate: boolean): void {
  saveSummarySettings({
    ...getSummarySettings(),
    supervision_enabled: enabled,
    supervision_lsp_freeze: lspFreeze,
    supervision_vibrate: vibrate,
  });
}

function everyAction(requestId: string) {
  return sendDeviceCommands({
    request_id: requestId,
    commands: [{
      device_id: DEVICE_ID,
      freeze_commands: ["com.video"],
      unfreeze_commands: ["com.reader"],
      vibrate: true,
      screen_off: true,
      say: "回到目标",
    }],
  }).commands[0]!;
}

describe("device command boundaries", () => {
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite file locked until the process exits.
    }
  });

  test("supervision off keeps restricting actions away from every controller", () => {
    setSwitches(false, true, true);
    const command = everyAction("req_boundary_off");

    expect(command.payload.payload).toMatchObject({
      freeze_commands: [],
      unfreeze_commands: ["com.reader"],
      vibrate: false,
      screen_off: false,
      say: "回到目标",
      notes: ["supervision_disabled"],
    });
    expect(command.delivery.status).not.toBe("skipped");
  });

  test("the freeze and vibrate switches narrow what a controller may do", () => {
    setSwitches(true, false, false);
    const command = everyAction("req_boundary_narrow");

    expect(command.payload.payload).toMatchObject({
      freeze_commands: [],
      vibrate: false,
      screen_off: true,
      notes: ["freeze_disabled_by_user", "vibrate_disabled_by_user"],
    });
  });

  test("a command left with only user-blocked actions is ignored, not unsupported", () => {
    setSwitches(false, false, false);
    const command = sendDeviceCommands({
      request_id: "req_boundary_only_blocked",
      commands: [{ device_id: DEVICE_ID, freeze_commands: ["com.video"], vibrate: true }],
    }).commands[0]!;

    expect(command.delivery.status).toBe("skipped");
    expect(command.result.status).toBe("ignored");
    expect(command.result.payload.reason).toBe("supervision_disabled");
  });

  test("allowed actions pass through unchanged", () => {
    setSwitches(true, true, true);
    const command = everyAction("req_boundary_allowed");

    expect(command.payload.payload).toMatchObject({
      freeze_commands: ["com.video"],
      vibrate: true,
      screen_off: true,
      notes: [],
    });
  });

  test("a retried request_id replays the stored commands instead of sending again", () => {
    setSwitches(true, true, true);
    const input = {
      request_id: "req_boundary_retry",
      commands: [{ device_id: DEVICE_ID, vibrate: true, say: "专注" }],
    };
    const first = sendDeviceCommands(input);
    const retry = sendDeviceCommands({
      request_id: "req_boundary_retry",
      commands: [{ say: "专注", vibrate: true, device_id: DEVICE_ID }],
    });

    expect(first.duplicate).toBeUndefined();
    expect(retry.duplicate).toBe(true);
    expect(retry.commands.map((command) => command.command_id))
      .toEqual(first.commands.map((command) => command.command_id));
    const rows = db.prepare("SELECT COUNT(*) AS count FROM device_commands WHERE request_id = ?")
      .get("req_boundary_retry") as { count: number };
    expect(rows.count).toBe(1);
    const messages = db.prepare("SELECT COUNT(*) AS count FROM device_messages WHERE device_id = ? AND id = ?")
      .get(DEVICE_ID, first.commands[0]!.command_id) as { count: number };
    expect(messages.count).toBe(1);
  });

  test("different commands under a used request_id are a conflict", () => {
    setSwitches(true, true, true);
    sendDeviceCommands({ request_id: "req_boundary_conflict", commands: [{ device_id: DEVICE_ID, say: "a" }] });

    expect(() => sendDeviceCommands({
      request_id: "req_boundary_conflict",
      commands: [{ device_id: DEVICE_ID, say: "b" }],
    })).toThrow("request_id_conflict");
  });
});
