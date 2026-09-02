import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  getDeviceInstalledApps,
  getDeviceFrozenList,
  getTimelineContext,
  listDeviceContexts,
} from "./device-context";
import { getCommandStatuses } from "./device-command-ledger";
import { sendDeviceCommands } from "./device-control";
import { getControllerPersona, updateControllerPersona } from "./controller-persona";
import { getControllerMemoryFeed, saveControllerSummary } from "./controller-memory";
import {
  getServiceAiJob,
  getServiceSettings,
  runServiceSupervisionCheck,
  setServiceSummaryMode,
  startServiceAiJob,
  updateServiceSettings,
} from "./mcp-admin";
import {
  AiJobStatusSchema,
  CommandStatusSchema,
  ControllerMemoryFeedSchema,
  ControllerPersonaUpdateSchema,
  DateRangeSchema,
  DeviceTimelineSchema,
  FrozenListSchema,
  InstalledAppsSchema,
  RunSupervisionCheckSchema,
  SaveControllerSummarySchema,
  SendCommandsSchema,
  ServiceSettingsUpdateSchema,
  SetSummaryModeSchema,
  StartAiJobSchema,
  SupervisionPolicySchema,
} from "./mcp-tool-schemas";
import { setAndSendSupervisionPolicy } from "./supervision-policy-control";

export function createLiveDashboardMcpServer(): McpServer {
  const server = new McpServer({
    name: "live-dashboard-mcp",
    version: "0.1.0",
  }, {
    instructions: [
      "Live Dashboard MCP exposes local-only device context and control tools.",
      "Read-only tools inspect dashboard state; they never change settings or device state.",
      "live_dashboard.send_device_commands is only for immediate one-shot device actions such as say, vibrate, screen_off, freeze, or unfreeze.",
      "live_dashboard.set_supervision_policy is the delegated controller's strategy interface for persistent Android LSP review triggers and app time limits. The active controller should create, revise, or clear the complete policy from the current goal and evidence instead of waiting for the user to enumerate packages. Risk triggers request controller review; they do not themselves authorize a freeze.",
      "OpenClaw/Hermes controllers may use service settings and AI job tools for server-side administration; the phone app cannot change the locked summary tone.",
      "OpenClaw/Hermes controllers may sync their persona or subordinate relationship so summaries, supervision, and reminders keep the same voice without overriding safety, privacy, schema, or device capability rules.",
      "Prefer letting OpenClaw/Hermes process memory and summaries: use get_controller_memory_feed to ingest sent messages, replies, device reminders, and saved summaries, then save_controller_summary when the controller has produced the authoritative summary.",
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

  server.registerTool("live_dashboard.get_device_installed_apps", {
    title: "Get device installed apps",
    description: "Return the latest non-system installed app snapshot reported by one Android LSP device.",
    inputSchema: InstalledAppsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(() => getDeviceInstalledApps(args.device_id)));

  server.registerTool("live_dashboard.send_device_commands", {
    title: "Send device commands",
    description: "Immediate one-shot device action tool. Use only to send current supervision/reminder actions to specific devices: say, vibrate, screen_off, freeze_commands, or unfreeze_commands. Do not use for persistent risk-app policy, app time limits, or changing supervision settings. Returns command_id values for status queries.",
    inputSchema: SendCommandsSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => stableToolResult(() => sendDeviceCommands(args)));

  server.registerTool("live_dashboard.set_supervision_policy", {
    title: "Set supervision policy",
    description: "Delegated-controller persistent strategy tool. The active controller must submit a complete policy snapshot with its matching controller identity and rationale, derived from the current goal, commitments, installed apps, and bounded evidence. Do not ask the user to enumerate packages. Risk triggers request controller review and do not freeze by themselves. Use send_device_commands for a freeze chosen in the current review.",
    inputSchema: SupervisionPolicySchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => stableToolResult(() => setAndSendSupervisionPolicy(args)));

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

  server.registerTool("live_dashboard.get_service_settings", {
    title: "Get service settings",
    description: "Return server-side summary, AI request, and supervision settings. Use this before changing policy or triggering AI jobs.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => stableToolResult(() => getServiceSettings()));

  server.registerTool("live_dashboard.update_service_settings", {
    title: "Update service settings",
    description: "Server-side settings update for OpenClaw/Hermes controllers. Uses snake_case fields and true/false booleans. Does not allow phone-style summary mode changes; use set_summary_mode for server-controlled tone.",
    inputSchema: ServiceSettingsUpdateSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => stableToolResult(() => updateServiceSettings(args)));

  server.registerTool("live_dashboard.set_summary_mode", {
    title: "Set summary mode",
    description: "Set the server-controlled summary/supervision tone: gentle, normal, or sharp. Phone settings updates cannot override this value; AI_SUMMARY_MODE environment variable overrides this tool.",
    inputSchema: SetSummaryModeSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(() => setServiceSummaryMode(args)));

  server.registerTool("live_dashboard.get_controller_persona", {
    title: "Get controller persona",
    description: "Return the synced OpenClaw/Hermes controller persona and subordinate/affiliate relationship used to align AI summaries, supervision, and reminders.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => stableToolResult(() => ({
    generated_at: new Date().toISOString(),
    persona: getControllerPersona(),
  })));

  server.registerTool("live_dashboard.update_controller_persona", {
    title: "Update controller persona",
    description: "Sync OpenClaw/Hermes persona or subordinate relationship into Live Dashboard. This guides summary/supervision/reminder voice, but cannot override security, privacy, JSON schema, or device capability constraints.",
    inputSchema: ControllerPersonaUpdateSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(() => ({
    ok: true,
    persona: updateControllerPersona(args),
  })));

  server.registerTool("live_dashboard.get_controller_memory_feed", {
    title: "Get controller memory feed",
    description: "Return a chronological feed of sent/received messages, device reminders/commands, and saved summaries for OpenClaw/Hermes memory ingestion. This is preferred over letting the service invent long-term memory itself.",
    inputSchema: ControllerMemoryFeedSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(() => getControllerMemoryFeed(args)));

  server.registerTool("live_dashboard.save_controller_summary", {
    title: "Save controller summary",
    description: "Persist an OpenClaw/Hermes-processed daily or weekly summary as the authoritative service summary, keeping memory and style consistent with the controlling agent.",
    inputSchema: SaveControllerSummarySchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(() => saveControllerSummary(args)));

  server.registerTool("live_dashboard.start_ai_job", {
    title: "Start AI job",
    description: "Start a daily summary, weekly summary, supervision rules refresh, or supervision check job and return the job request_id. Use get_ai_job to monitor completion.",
    inputSchema: StartAiJobSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(() => startServiceAiJob(args)));

  server.registerTool("live_dashboard.get_ai_job", {
    title: "Get AI job",
    description: "Read AI job status/result by request_id.",
    inputSchema: AiJobStatusSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(() => getServiceAiJob(args)));

  server.registerTool("live_dashboard.run_supervision_check", {
    title: "Run supervision check",
    description: "Queue an immediate supervision review using saved rules, timeline context, and device capabilities. Returns quickly with an AI job request_id; use get_ai_job to monitor completion.",
    inputSchema: RunSupervisionCheckSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => stableToolResult(() => runServiceSupervisionCheck(args)));

  return server;
}

function toolResult(value: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

async function stableToolResult(build: () => unknown | Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await build();
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
