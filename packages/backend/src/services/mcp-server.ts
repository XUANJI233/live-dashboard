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
import { getControllerContext } from "./controller-context";
import { controllerContextText } from "./controller-context-budget";
import {
  completeServiceAiJob,
  claimServiceAiJobs,
  getServiceAiJob,
  getServiceSettings,
  runServiceSupervisionCheck,
  setServiceSummaryMode,
  startServiceAiJob,
  updateServiceSettings,
} from "./mcp-admin";
import {
  AiJobStatusSchema,
  AccountingBillsSchema,
  CaptureScreenshotSchema,
  CommandStatusSchema,
  ClaimControllerAiRequestsSchema,
  CompleteControllerAiRequestSchema,
  ControllerContextSchema,
  ControllerMemoryFeedSchema,
  ControllerPersonaUpdateSchema,
  CoyoteAdjustSchema,
  CoyoteChangeWaveSchema,
  CoyoteEmergencyStopSchema,
  CoyoteStartSchema,
  CoyoteStatusSchema,
  CoyoteStopSchema,
  DateRangeSchema,
  DeviceTimelineSchema,
  FrozenListSchema,
  GetScreenshotSchema,
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
import {
  captureDeviceScreenshot,
  consumeReadyScreenshot,
  getDeviceScreenshot,
  type ScreenshotCaptureResult,
} from "./device-screenshot-control";
import { queryAccountingBills } from "./accounting-bills";
import {
  executeCoyoteCommand,
  getCoyoteStatuses,
  requestAccountingSync,
} from "./android-integration-control";

export function createLiveDashboardMcpServer(): McpServer {
  const server = new McpServer({
    name: "live-dashboard-mcp",
    version: "0.1.0",
  }, {
    instructions: [
      "Live Dashboard MCP exposes local-only device context and control tools.",
      "Read-only tools inspect dashboard state; they never change settings or device state.",
      "Hermes should start each decision with live_dashboard.get_controller_context and avoid separate settings, persona, device, timeline, and memory reads. Its bounds.truncated flag only means older or lower-priority detail was omitted; do not re-read solely for that flag because bounds.decision_complete remains true and bounds.followup_required remains false. Its usage_digest covers the whole window; supervision, companion, and followup timelines keep only the newest segments. Read one specific detail only after choosing an action that requires it, or call get_device_timeline once for one device and window when the digest leaves a decision-relevant question.",
      "live_dashboard.send_device_commands is only for immediate one-shot device actions such as say, vibrate, screen_off, freeze, or unfreeze.",
      "live_dashboard.capture_device_screenshot captures the current Android LSP display on demand and may be used whenever current visual evidence is relevant. The screenshot is short-lived and returned once.",
      "Coyote electrostimulation tools only operate an Android-connected device after the user explicitly enables remote control. Cold starts and adjustments are hard-bounded; stop and emergency stop remain available without that grant.",
      "get_accounting_bills reads only AutoAccounting bills that are already Edited or Synced; Live Dashboard does not reproduce AutoAccounting recognition rules.",
      "live_dashboard.set_supervision_policy is the delegated controller's strategy interface for persistent Android LSP review triggers, app time limits, and the strict system-browser web allowlist. The active controller should create, revise, or clear the complete policy from the current goal and evidence instead of waiting for the user to enumerate packages. Risk triggers request controller review; they do not themselves authorize a freeze.",
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

  server.registerTool("live_dashboard.get_accounting_bills", {
    title: "Get processed AutoAccounting bills",
    description: "Ask an online Android integration to read AutoAccounting's completed parent bills (Edited/Synced), cache them idempotently, then query the bounded server copy. Recognition rules and pending Wait2Edit data are never reproduced here.",
    inputSchema: AccountingBillsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(async () => {
    const refresh = args.refresh_from_android === false
      ? { ok: true, status: "skipped" }
      : await requestAccountingSync({ deviceId: args.device_id, start: args.start, end: args.end });
    return {
      refresh,
      ...queryAccountingBills({
        start: args.start,
        end: args.end,
        deviceId: args.device_id,
        transactionTypes: args.transaction_types,
        category: args.category,
        keyword: args.keyword,
        limit: args.limit,
        cursor: args.cursor,
      }),
    };
  }));

  server.registerTool("live_dashboard.get_coyote_status", {
    title: "Get Android Coyote status",
    description: "Return Android integration connectivity, explicit remote-control grant, channel strengths and limits, battery, waveform, and output state. This never changes the device.",
    inputSchema: CoyoteStatusSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(() => getCoyoteStatuses(args.device_id)));

  server.registerTool("live_dashboard.coyote_start", {
    title: "Start Coyote channel",
    description: "Start one Android-connected Coyote electrostimulation channel with a built-in waveform. Requires the user's live remote-control grant; cold-start strength is capped at 10 and then by the user's local channel limit.",
    inputSchema: CoyoteStartSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => stableToolResult(() => executeCoyoteCommand(args.device_id, args.request_id, { action: "start", ...args })));

  server.registerTool("live_dashboard.coyote_adjust", {
    title: "Adjust Coyote strength",
    description: "Relatively adjust one running Coyote channel by at most plus or minus 10. Requires the user's live remote-control grant and remains bounded by local channel limits.",
    inputSchema: CoyoteAdjustSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => stableToolResult(() => executeCoyoteCommand(args.device_id, args.request_id, { action: "adjust", ...args })));

  server.registerTool("live_dashboard.coyote_change_wave", {
    title: "Change Coyote waveform",
    description: "Change the waveform of one already running Coyote channel without changing strength. Requires the user's live remote-control grant.",
    inputSchema: CoyoteChangeWaveSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => stableToolResult(() => executeCoyoteCommand(args.device_id, args.request_id, { action: "change_wave", ...args })));

  server.registerTool("live_dashboard.coyote_stop", {
    title: "Stop Coyote output",
    description: "Stop one Coyote channel or both channels. Stop remains available even when the user has disabled remote starts and adjustments.",
    inputSchema: CoyoteStopSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(() => executeCoyoteCommand(args.device_id, args.request_id, { action: "stop", ...args })));

  server.registerTool("live_dashboard.coyote_emergency_stop", {
    title: "Emergency stop Coyote",
    description: "Immediately force both Coyote channels to zero and clear active waveforms. Always use this instead of a start-strength-zero workaround.",
    inputSchema: CoyoteEmergencyStopSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(() => executeCoyoteCommand(args.device_id, args.request_id, { action: "emergency_stop" })));

  server.registerTool("live_dashboard.capture_device_screenshot", {
    title: "Capture device screenshot",
    description: "Capture the current display from one capable Android LSP device. This is pre-authorized for Hermes whenever current visual evidence is relevant. The tool waits event-first for the upload and returns an MCP image; on timeout it returns screenshot_id for get_device_screenshot.",
    inputSchema: CaptureScreenshotSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => screenshotToolResult(consumeReadyScreenshot(await captureDeviceScreenshot(args))));

  server.registerTool("live_dashboard.get_device_screenshot", {
    title: "Get device screenshot",
    description: "Retrieve a pending screenshot by screenshot_id after capture_device_screenshot returned pending. A ready image is returned once and then removed.",
    inputSchema: GetScreenshotSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => screenshotToolResult(getDeviceScreenshot(args.screenshot_id)));

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

  server.registerTool("live_dashboard.get_controller_context", {
    title: "Get bounded controller context",
    description: "Preferred first and normally only read for Hermes decisions. Returns settings, persona, minimal device state, a whole-window usage digest, one bounded timeline (newest segments only in supervision, companion, and followup modes), and recent controller events in one call. Bounded truncation preserves a decision-complete newest-first view and never by itself requires another read.",
    inputSchema: ControllerContextSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(
    () => getControllerContext(args),
    controllerContextText,
  ));

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

  server.registerTool("live_dashboard.claim_controller_ai_requests", {
    title: "Claim delegated Live AI requests",
    description: "Dedicated Hermes batch consumer. Atomically claims up to 20 delegated requests with a 30-minute lease so concurrent jobs cannot process the same work.",
    inputSchema: ClaimControllerAiRequestsSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => stableToolResult(() => claimServiceAiJobs(args)));

  server.registerTool("live_dashboard.complete_controller_ai_request", {
    title: "Complete delegated Live AI request",
    description: "After processing a claimed ai.work_requested item, mark its Live AI job succeeded, skipped, or failed. Call exactly once with the request_id and claim_token returned by claim_controller_ai_requests.",
    inputSchema: CompleteControllerAiRequestSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(() => completeServiceAiJob(args)));

  server.registerTool("live_dashboard.run_supervision_check", {
    title: "Run supervision check",
    description: "Queue an immediate supervision review using saved rules, timeline context, and device capabilities. Returns quickly with an AI job request_id; use get_ai_job to monitor completion.",
    inputSchema: RunSupervisionCheckSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => stableToolResult(() => runServiceSupervisionCheck(args)));

  return server;
}

function screenshotToolResult(result: ScreenshotCaptureResult): CallToolResult {
  const metadata: Record<string, unknown> = {
    status: result.status,
    screenshot_id: result.screenshot_id,
    command_id: result.command_id,
    device_id: result.device_id,
    ...(result.error ? { error: result.error } : {}),
  };
  if (result.status !== "ready" || !result.record?.image_data) {
    return toolResult(metadata);
  }
  Object.assign(metadata, {
    mime_type: result.record.mime_type,
    width: result.record.width,
    height: result.record.height,
    captured_at: result.record.uploaded_at,
  });
  return {
    structuredContent: metadata,
    content: [{
      type: "image",
      data: Buffer.from(result.record.image_data).toString("base64"),
      mimeType: result.record.mime_type,
    }],
  };
}

function toolResult(value: Record<string, unknown>, text?: string): CallToolResult {
  return {
    structuredContent: value,
    content: [{ type: "text", text: text ?? JSON.stringify(value, null, 2) }],
  };
}

async function stableToolResult(
  build: () => unknown | Promise<unknown>,
  textView?: (value: Record<string, unknown>) => string,
): Promise<CallToolResult> {
  try {
    const value = objectResult(await build());
    return toolResult(value, textView?.(value));
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
