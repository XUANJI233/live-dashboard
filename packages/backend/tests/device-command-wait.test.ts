import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-command-wait-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

const { db } = await import("../src/db");
const { sendDeviceCommands } = await import("../src/services/device-control");
const { awaitCommandResults } = await import("../src/services/device-command-wait");

const PHONE = "android-wait";
db.prepare(`
  INSERT OR REPLACE INTO device_states (
    device_id, device_name, platform, app_id, app_name, window_title, display_title, last_seen_at, extra, is_online
  ) VALUES (?, 'Phone', 'android', 'com.example', 'Example', '', 'Example', datetime('now'), ?, 1)
`).run(PHONE, JSON.stringify({ device: { profile: "android_lsp", capabilities: { say: true } } }));

describe("awaiting device results", () => {
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite file locked until the process exits.
    }
  });

  test("returns as soon as a delivered command reports its result", async () => {
    const sent = sendDeviceCommands({ request_id: "req_wait_result", commands: [{ device_id: PHONE, say: "在吗" }] });
    const commandId = sent.commands[0]!.command_id;
    db.prepare("UPDATE device_commands SET delivery_status = 'sent' WHERE command_id = ?").run(commandId);
    const delivered = { ...sent, commands: sent.commands.map((command) => ({ ...command, delivery: { ...command.delivery, status: "sent" as const } })) };
    setTimeout(() => {
      db.prepare("UPDATE device_commands SET result_status = 'applied', result_at = ? WHERE command_id = ?")
        .run(new Date().toISOString(), commandId);
    }, 200);

    const started = Date.now();
    const awaited = await awaitCommandResults(delivered, 2_000);

    expect(awaited.results_pending).toBe(false);
    expect(awaited.commands[0]!.result.status).toBe("applied");
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("a queued command for a disconnected phone does not hold the call", async () => {
    const sent = sendDeviceCommands({ request_id: "req_wait_queued", commands: [{ device_id: PHONE, say: "在吗" }] });
    const started = Date.now();
    const awaited = await awaitCommandResults(sent, 2_000);
    expect(Date.now() - started).toBeLessThan(100);
    expect(awaited.commands[0]!.delivery.status).not.toBe("sent");
  });
});
