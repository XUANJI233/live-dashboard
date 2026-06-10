import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  getDeviceFrozenList,
  getTimelineContext,
  listDeviceContexts,
} from "./device-context";
import { getCommandStatuses } from "./device-command-ledger";
import { sendDeviceCommands } from "./device-control";
import {
  CommandStatusSchema,
  DateRangeSchema,
  DeviceTimelineSchema,
  FrozenListSchema,
  SendCommandsSchema,
} from "./mcp-tool-schemas";

export function createLiveDashboardMcpServer(): McpServer {
  const server = new McpServer({
    name: "live-dashboard-mcp",
    version: "0.1.0",
  }, {
    instructions: [
      "Live Dashboard MCP exposes local-only device context and control tools.",
      "Use command_id to query delivery, receipt, and execution status after sending commands.",
      "Tool results translate transport failures into delivery/receipt/result states instead of exposing raw socket errors.",
    ].join(" "),
  });

  server.registerTool("live_dashboard.list_devices", {
    title: "List devices and capabilities",
    description: "Return known devices, current app state, command capability profile, and frozen packages.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => stableToolResult(() => ({
    generated_at: new Date().toISOString(),
    devices: listDeviceContexts(),
  })));

  server.registerTool("live_dashboard.get_all_device_timeline", {
    title: "Get all-device timeline",
    description: "Return a sanitized, device-grouped activity timeline for every device in an ISO time range.",
    inputSchema: DateRangeSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(() => getTimelineContext({
    start: args.start,
    end: args.end,
    limit: args.limit,
    timezoneOffsetMinutes: args.timezone_offset_minutes,
  })));

  server.registerTool("live_dashboard.get_device_timeline", {
    title: "Get device timeline",
    description: "Return a sanitized activity timeline for one device in an ISO time range.",
    inputSchema: DeviceTimelineSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(() => getTimelineContext({
    start: args.start,
    end: args.end,
    deviceId: args.device_id,
    limit: args.limit,
    timezoneOffsetMinutes: args.timezone_offset_minutes,
  })));

  server.registerTool("live_dashboard.get_device_frozen_list", {
    title: "Get frozen list",
    description: "Return the current frozen package list reported by one device.",
    inputSchema: FrozenListSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(() => getDeviceFrozenList(args.device_id)));

  server.registerTool("live_dashboard.send_device_commands", {
    title: "Send device commands",
    description: "Send per-device supervision commands after capability filtering. Returns AI-visible command_id values for status queries.",
    inputSchema: SendCommandsSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => stableToolResult(() => sendDeviceCommands(args)));

  server.registerTool("live_dashboard.get_command_status", {
    title: "Get command status",
    description: "Query command delivery, receipt, and execution result by command_id or request_id.",
    inputSchema: CommandStatusSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(() => {
    if (!args.command_id && !args.request_id) {
      return { found: false, error: "command_id_or_request_id_required", commands: [] };
    }
    return getCommandStatuses({
      commandId: args.command_id,
      requestId: args.request_id,
    });
  }));

  return server;
}

function toolResult(value: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function stableToolResult(build: () => unknown): CallToolResult {
  try {
    const value = build();
    return toolResult(objectResult(value));
  } catch (error) {
    const code = error instanceof Error && stableErrorCode(error.message)
      ? error.message
      : "internal_error";
    if (code === "internal_error") {
      console.error("[mcp] tool failed:", error);
    }
    return toolResult({ ok: false, error: code });
  }
}

function objectResult(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

function stableErrorCode(value: string): boolean {
  return /^[a-z][a-z0-9_]{2,80}$/.test(value);
}
