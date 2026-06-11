import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-mcp-control-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
process.env.MCP_SERVER_TOKEN = "local-mcp-token";

describe("mcp control plane", () => {
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // The shared Bun test process may keep SQLite handles open briefly.
    }
  });

  test("rejects non-local MCP requests before JSON-RPC handling", async () => {
    const { handleMcpRequest } = await import("../src/routes/mcp");
    const response = await handleMcpRequest(mcpRequest({ method: "tools/list" }), {
      remoteAddress: "203.0.113.10",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "local_mcp_only" });
  });

  test("serves MCP tools/list over local JSON response transport", async () => {
    const { handleMcpRequest } = await import("../src/routes/mcp");
    const response = await handleMcpRequest(mcpRequest({ method: "tools/list" }), {
      remoteAddress: "127.0.0.1",
    });
    const body = await response.json() as { result?: { tools?: Array<{ name: string }> }; error?: unknown };

    expect(response.status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.result?.tools?.map((tool) => tool.name)).toContain("live_dashboard.send_device_commands");
    expect(body.result?.tools?.map((tool) => tool.name)).toContain("live_dashboard.set_supervision_policy");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("allows local MCP without a token when no MCP token is configured", async () => {
    const { handleMcpRequest } = await import("../src/routes/mcp");
    const previous = process.env.MCP_SERVER_TOKEN;
    delete process.env.MCP_SERVER_TOKEN;
    try {
      const response = await handleMcpRequest(mcpRequest({ method: "tools/list" }, { auth: false }), {
        remoteAddress: "::1",
      });
      const body = await response.json() as { result?: { tools?: Array<{ name: string }> } };

      expect(response.status).toBe(200);
      expect(body.result?.tools?.length).toBeGreaterThan(0);
    } finally {
      process.env.MCP_SERVER_TOKEN = previous;
    }
  });

  test("calls send_device_commands through the MCP transport", async () => {
    const { db } = await import("../src/db");
    const { handleMcpRequest } = await import("../src/routes/mcp");
    insertDeviceState(db, {
      device_id: "android-mcp-call",
      device_name: "Phone MCP",
      platform: "android",
      extra: JSON.stringify({ device: { profile: "android_lsp" } }),
    });

    const response = await handleMcpRequest(mcpRequest({
      method: "tools/call",
      params: {
        name: "live_dashboard.send_device_commands",
        arguments: {
          request_id: "req_mcp_call",
          commands: [{
            device_id: "android-mcp-call",
            freeze_commands: ["com.video"],
            vibrate: true,
            say: "回到目标",
          }],
        },
      },
    }), { remoteAddress: "127.0.0.1" });
    const body = await response.json() as {
      result?: { structuredContent?: { commands?: Array<{ command_id: string; delivery: { status: string } }> } };
      error?: unknown;
    };

    expect(response.status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.result?.structuredContent?.commands?.[0]?.delivery.status).toBe("queued");
  });

  test("sends supervision commands through the local AI MCP client", async () => {
    const { db } = await import("../src/db");
    const { sendDeviceCommandsViaMcp } = await import("../src/services/ai-mcp");
    insertDeviceState(db, {
      device_id: "android-ai-mcp",
      device_name: "Phone AI MCP",
      platform: "android",
      extra: JSON.stringify({ device: { profile: "android_lsp" } }),
    });

    const sent = await sendDeviceCommandsViaMcp({
      request_id: "req_ai_mcp_supervision",
      commands: [{
        device_id: "android-ai-mcp",
        freeze_commands: ["com.video"],
        vibrate: true,
        say: "回到目标",
      }],
    });

    expect(sent.request_id).toBe("req_ai_mcp_supervision");
    expect((sent.commands[0] as { delivery?: { status?: string } } | undefined)?.delivery?.status).toBe("queued");
    expect((sent.commands[0] as { created_by?: string } | undefined)?.created_by).toBe("mcp");

    const row = db.prepare("SELECT created_by FROM device_commands WHERE request_id = ? LIMIT 1")
      .get("req_ai_mcp_supervision") as { created_by?: string } | null;
    expect(row?.created_by).toBe("mcp");
  });

  test("marks supervision device commands with the supervision source", async () => {
    const { db } = await import("../src/db");
    const { sendSupervisionDeviceCommands } = await import("../src/services/supervision-device-commands");
    insertDeviceState(db, {
      device_id: "android-supervision-source",
      device_name: "Phone Supervision",
      platform: "android",
      extra: JSON.stringify({ device: { profile: "android_lsp" } }),
    });

    const sent = await sendSupervisionDeviceCommands({
      supervision_lsp_freeze: true,
      supervision_vibrate: true,
    }, [{
      device_id: "android-supervision-source",
      deviated: true,
      message: "回到目标",
      reason: "偏离目标",
      vibrate: true,
      freeze: true,
      freeze_commands: ["com.video"],
      screen_off: false,
      unfreeze: false,
      unfreeze_commands: [],
    }]);

    const row = db.prepare("SELECT created_by FROM device_commands WHERE request_id = ? LIMIT 1")
      .get(sent.request_id) as { created_by?: string } | null;
    expect(row?.created_by).toBe("supervision");
    expect((sent.commands[0] as { created_by?: string } | undefined)?.created_by).toBe("supervision");
  });

  test("sends device commands through the ledger and records receipt/results", async () => {
    const { db } = await import("../src/db");
    const { sendDeviceCommands } = await import("../src/services/device-control");
    const { getCommandStatuses } = await import("../src/services/device-command-ledger");
    const {
      receiveDeviceCommandReceipt,
      receiveDeviceCommandResult,
    } = await import("../src/services/supervision-ack");

    insertDeviceState(db, {
      device_id: "android-lsp",
      device_name: "Phone",
      platform: "android",
      extra: JSON.stringify({
        device: {
          profile: "android_lsp",
          frozen_packages: [{
            package_name: "com.video",
            app_name: "Video",
            mode: "suspended",
            reason: "偏离目标",
          }],
        },
      }),
    });

    const sent = sendDeviceCommands({
      request_id: "req_test",
      commands: [{
        device_id: "android-lsp",
        freeze_commands: ["com.video"],
        unfreeze_commands: ["Video"],
        vibrate: true,
        screen_off: true,
        say: "回到目标",
      }],
    });

    const command = sent.commands[0]!;
    expect(sent.request_id).toBe("req_test");
    expect(command.delivery.status).toBe("queued");
    expect(command.receipt.status).toBe("missing");
    expect(command.result.status).toBe("unknown");
    expect(command.payload.payload).toMatchObject({
      kind: "supervision",
      freeze_commands: ["com.video"],
      unfreeze_commands: ["Video"],
      vibrate: true,
      screen_off: false,
      say: "回到目标",
      notes: ["screen_off_not_supported"],
    });

    const queued = db.prepare("SELECT payload FROM device_messages WHERE id = ? AND device_id = ?")
      .get(command.command_id, "android-lsp") as { payload: string } | null;
    expect(queued).not.toBeNull();
    expect(JSON.parse(queued!.payload)).toMatchObject({
      type: "device_command",
      command_id: command.command_id,
      request_id: "req_test",
    });

    const device = { device_id: "android-lsp", device_name: "Phone", platform: "android" as const };
    const receipt = receiveDeviceCommandReceipt({
      type: "device_command_receipt",
      request_id: "req_test",
      command_id: command.command_id,
      status: "received",
      received_at: "2026-06-10T10:00:00.000Z",
    }, device);
    expect(receipt.received).toBe(true);

    const result = receiveDeviceCommandResult({
      type: "device_command_result",
      request_id: "req_test",
      command_id: command.command_id,
      result_id: "res_test",
      status: "applied",
      executed_at: "2026-06-10T10:00:01.000Z",
      actions: [{ action: "freeze", package_name: "com.video" }],
      state_after: { frozen_packages: ["com.video"] },
    }, device);
    expect(result).toMatchObject({
      received: true,
      command_id: command.command_id,
      request_id: "req_test",
      result_id: "res_test",
    });

    const duplicate = receiveDeviceCommandResult({
      type: "device_command_result",
      request_id: "req_test",
      command_id: command.command_id,
      result_id: "res_test",
      status: "applied",
    }, device);
    expect(duplicate.duplicate).toBe(true);

    const status = getCommandStatuses({ commandId: command.command_id }).commands[0]!;
    expect(status.receipt.status).toBe("received");
    expect(status.result.status).toBe("applied");
    expect(status.result.result_id).toBe("res_test");
  });

  test("uses explicit boolean device capabilities and bounds them by profile", async () => {
    const { db } = await import("../src/db");
    const { sendDeviceCommands } = await import("../src/services/device-control");
    const { getDeviceContext } = await import("../src/services/device-context");

    insertDeviceState(db, {
      device_id: "android-lsp-no-freeze",
      device_name: "Phone limited",
      platform: "android",
      extra: JSON.stringify({
        device: {
          profile: "android_lsp",
          capabilities: {
            freeze: false,
            unfreeze: false,
            vibrate: true,
            screen_off: true,
            say: true,
            risk_app_monitor: true,
            app_time_limit: true,
          },
        },
      }),
    });

    expect(getDeviceContext("android-lsp-no-freeze")?.capability.capabilities).toEqual({
      freeze: false,
      unfreeze: false,
      vibrate: true,
      screen_off: false,
      say: true,
      risk_app_monitor: true,
      app_time_limit: true,
    });

    const sent = sendDeviceCommands({
      request_id: "req_capabilities",
      commands: [{
        device_id: "android-lsp-no-freeze",
        freeze_commands: ["com.video"],
        vibrate: true,
        screen_off: true,
        say: "回到目标",
      }],
    });

    expect(sent.commands[0]?.payload.payload).toMatchObject({
      freeze_commands: [],
      vibrate: true,
      screen_off: false,
      say: "回到目标",
      notes: ["screen_off_not_supported", "freeze_not_supported"],
    });
  });

  test("sends supervision policy only to devices with policy capabilities", async () => {
    const { db } = await import("../src/db");
    const { setAndSendSupervisionPolicy } = await import("../src/services/supervision-policy-control");

    insertDeviceState(db, {
      device_id: "android-policy-lsp",
      device_name: "Policy LSP",
      platform: "android",
      extra: JSON.stringify({
        device: {
          profile: "android_lsp",
          capabilities: {
            freeze: true,
            unfreeze: true,
            vibrate: true,
            screen_off: false,
            say: true,
            risk_app_monitor: true,
            app_time_limit: true,
          },
        },
      }),
    });
    insertDeviceState(db, {
      device_id: "android-policy-normal",
      device_name: "Policy Normal",
      platform: "android",
      extra: JSON.stringify({
        device: {
          profile: "android_normal",
          capabilities: {
            freeze: false,
            unfreeze: false,
            vibrate: true,
            screen_off: false,
            say: true,
            risk_app_monitor: false,
            app_time_limit: false,
          },
        },
      }),
    });
    insertDeviceState(db, {
      device_id: "desktop-policy",
      device_name: "Policy Desktop",
      platform: "windows",
      extra: JSON.stringify({
        device: {
          profile: "desktop_message",
          capabilities: {
            freeze: false,
            unfreeze: false,
            vibrate: false,
            screen_off: false,
            say: true,
            risk_app_monitor: false,
            app_time_limit: false,
          },
        },
      }),
    });

    const sent = setAndSendSupervisionPolicy({
      request_id: "req_policy_capabilities",
      device_ids: ["android-policy-lsp", "android-policy-normal", "desktop-policy"],
      risk_app_regex: ["Video"],
      risk_trigger_minutes: 3,
      app_time_limits: [{ app_regex: "Game", limit_minutes: 10, reason: "限时" }],
    });

    expect(sent.policy).toEqual({
      risk_app_regex: ["Video"],
      risk_trigger_minutes: 3,
      app_time_limits: [{ app_regex: "Game", limit_minutes: 10, reason: "限时" }],
    });
    expect(sent.commands.map((item) => ({
      target: item.target_device_id,
      kind: item.kind,
      delivery: item.delivery.status,
      result: item.result.status,
      reason: item.result.payload.reason,
    }))).toEqual([
      {
        target: "android-policy-lsp",
        kind: "supervision_policy",
        delivery: "queued",
        result: "unknown",
        reason: undefined,
      },
      {
        target: "android-policy-normal",
        kind: "supervision_policy",
        delivery: "skipped",
        result: "unsupported",
        reason: "policy_capability_not_supported",
      },
      {
        target: "desktop-policy",
        kind: "supervision_policy",
        delivery: "skipped",
        result: "unsupported",
        reason: "policy_capability_not_supported",
      },
    ]);
    expect(sent.commands[0]?.payload.payload).toMatchObject({
      kind: "supervision_policy",
      risk_app_regex: ["Video"],
      risk_trigger_minutes: 3,
      app_time_limits: [{ app_regex: "Game", limit_minutes: 10, reason: "限时" }],
    });
    const policyTtlMs = Date.parse(sent.commands[0]!.expires_at) - Date.parse(sent.commands[0]!.issued_at);
    expect(policyTtlMs).toBeGreaterThanOrEqual(59 * 60_000);
  });

  test("syncs current supervision policy idempotently for reporting LSP devices", async () => {
    const { db } = await import("../src/db");
    const { updateSummarySettings, updateSupervisionPolicy } = await import("../src/services/daily-summary-gen");
    const {
      syncCurrentSupervisionPolicyForDevice,
      syncCurrentSupervisionPolicyToCapableDevices,
    } = await import("../src/services/supervision-policy-control");
    const deviceId = "android-policy-autosync";
    insertDeviceState(db, {
      device_id: deviceId,
      device_name: "Policy Auto Sync",
      platform: "android",
      extra: JSON.stringify({
        device: {
          profile: "android_lsp",
          capabilities: {
            freeze: true,
            unfreeze: true,
            vibrate: true,
            screen_off: false,
            say: true,
            risk_app_monitor: true,
            app_time_limit: true,
          },
        },
      }),
    });
    updateSummarySettings({
      client_updated_at: "2030-01-01T00:00:00.000Z",
      supervision_enabled: true,
    });
    updateSupervisionPolicy({
      risk_app_regex: ["Video"],
      risk_trigger_minutes: 3,
      app_time_limits: [{ app_regex: "Game", limit_minutes: 10, reason: "limit" }],
    });

    const first = syncCurrentSupervisionPolicyForDevice(deviceId);
    expect(first.synced).toBe(true);
    expect(first.commands[0]?.delivery.status).toBe("queued");
    expect(first.commands[0]?.payload.payload).toMatchObject({
      kind: "supervision_policy",
      risk_app_regex: ["Video"],
      app_time_limits: [{ app_regex: "Game", limit_minutes: 10, reason: "limit" }],
    });

    const countAfterFirst = policyCommandCount(db, deviceId);
    const duplicate = syncCurrentSupervisionPolicyForDevice(deviceId);
    expect(duplicate.synced).toBe(false);
    expect(duplicate.reason).toBe("policy_already_synced");
    expect(policyCommandCount(db, deviceId)).toBe(countAfterFirst);
    const duplicateAll = syncCurrentSupervisionPolicyToCapableDevices();
    expect(duplicateAll.commands.some((command) => command.target_device_id === deviceId)).toBe(false);
    expect(policyCommandCount(db, deviceId)).toBe(countAfterFirst);

    const metaKey = `supervision_policy_sync:${deviceId}`;
    const metaRow = db.prepare("SELECT value FROM meta WHERE key = ?").get(metaKey) as { value: string } | null;
    const staleMeta = { ...JSON.parse(metaRow!.value), recorded_at: "2000-01-01T00:00:00.000Z" };
    db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify(staleMeta), metaKey);
    const staleQueued = syncCurrentSupervisionPolicyForDevice(deviceId);
    expect(staleQueued.synced).toBe(true);
    expect(staleQueued.commands[0]?.delivery.status).toBe("queued");
    const countAfterStaleRetry = policyCommandCount(db, deviceId);
    expect(countAfterStaleRetry).toBe(countAfterFirst + 1);

    updateSupervisionPolicy({
      risk_app_regex: ["Video", "Shorts"],
      risk_trigger_minutes: 3,
      app_time_limits: [{ app_regex: "Game", limit_minutes: 10, reason: "limit" }],
    });
    const changed = syncCurrentSupervisionPolicyForDevice(deviceId);
    expect(changed.synced).toBe(true);
    expect(policyCommandCount(db, deviceId)).toBe(countAfterStaleRetry + 1);

    updateSummarySettings({
      client_updated_at: "2030-01-01T00:01:00.000Z",
      supervision_enabled: false,
    });
    const disabled = syncCurrentSupervisionPolicyForDevice(deviceId);
    expect(disabled.synced).toBe(true);
    expect(disabled.commands[0]?.payload.payload).toMatchObject({
      kind: "supervision_policy",
      risk_app_regex: [],
      app_time_limits: [],
    });
  });

  test("preserves detailed command result state for MCP status queries", async () => {
    const { db } = await import("../src/db");
    const { sendDeviceCommands } = await import("../src/services/device-control");
    const { getCommandStatuses } = await import("../src/services/device-command-ledger");
    const { receiveDeviceCommandResult } = await import("../src/services/supervision-ack");
    const suffix = crypto.randomUUID();
    const deviceId = `android-large-result-${suffix}`;
    insertDeviceState(db, {
      device_id: deviceId,
      device_name: "Large Result Phone",
      platform: "android",
      extra: JSON.stringify({ device: { profile: "android_lsp" } }),
    });

    const sent = sendDeviceCommands({
      request_id: `req_large_${suffix}`,
      commands: [{ device_id: deviceId, say: "同步冻结状态" }],
    });
    const command = sent.commands[0]!;
    const frozenPackages = Array.from({ length: 28 }, (_, index) => ({
      package_name: `com.example.long.package.${index}`,
      app_name: `Long Frozen App ${index}`,
      mode: "suspended",
      reason: `detailed supervision result ${index} `.repeat(4).trim(),
      until: "2026-06-11T19:00:00.000Z",
    }));

    const result = receiveDeviceCommandResult({
      type: "device_command_result",
      request_id: sent.request_id,
      command_id: command.command_id,
      result_id: `res_large_${suffix}`,
      status: "applied",
      executed_at: "2026-06-11T18:00:00.000Z",
      actions: [{ action: "say", status: "applied" }],
      state_after: { frozen_packages: frozenPackages },
    }, { device_id: deviceId, device_name: "Large Result Phone", platform: "android" });
    expect(result.received).toBe(true);

    const status = getCommandStatuses({ commandId: command.command_id }).commands[0]!;
    const payload = status.result.payload as any;
    expect(payload.state_after.frozen_packages).toHaveLength(frozenPackages.length);
    expect(payload.state_after.frozen_packages[0].package_name).toBe("com.example.long.package.0");
  });
});

function mcpRequest(message: Record<string, unknown>, options: { auth?: boolean } = {}): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (options.auth !== false) {
    headers.Authorization = "Bearer local-mcp-token";
  }
  return new Request("http://127.0.0.1/api/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      params: {},
      ...message,
    }),
  });
}

function insertDeviceState(db: typeof import("../src/db").db, row: {
  device_id: string;
  device_name: string;
  platform: string;
  extra: string;
}): void {
  db.prepare(`
    INSERT OR REPLACE INTO device_states (
      device_id,
      device_name,
      platform,
      app_id,
      app_name,
      window_title,
      display_title,
      last_seen_at,
      extra,
      is_online
    )
    VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, 1)
  `).run(
    row.device_id,
    row.device_name,
    row.platform,
    "com.example.current",
    "Current App",
    "Current title",
    "2026-06-10T09:59:00.000Z",
    row.extra,
  );
}

function policyCommandCount(db: typeof import("../src/db").db, deviceId: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM device_commands
    WHERE target_device_id = ? AND kind = 'supervision_policy'
  `).get(deviceId) as { count: number };
  return row.count;
}
