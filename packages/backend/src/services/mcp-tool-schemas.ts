import { z } from "zod";
import { ACCOUNTING_TRANSACTION_TYPES } from "./accounting-contracts";
import { COYOTE_WAVEFORMS } from "./coyote-control";

export const DateRangeSchema = z.object({
  start: z.string().describe("Inclusive ISO timestamp, for reading history only."),
  end: z.string().describe("Exclusive ISO timestamp, for reading history only."),
  limit: z.number().int().min(1).max(240).optional().describe("Maximum timeline sessions to return."),
  timezone_offset_minutes: z.number().int().min(-14 * 60).max(14 * 60).optional()
    .describe("JavaScript Date.getTimezoneOffset semantics; UTC+08:00 is -480."),
});

export const DeviceTimelineSchema = DateRangeSchema.extend({
  device_id: z.string().min(1).max(160),
});

export const FrozenListSchema = z.object({
  device_id: z.string().min(1).max(160),
});

export const InstalledAppsSchema = z.object({
  device_id: z.string().min(1).max(160),
});

export const ControllerContextSchema = z.object({
  mode: z.enum(["supervision", "companion", "followup", "memory", "policy", "daily", "weekly"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timezone_offset_minutes: z.number().int().min(-840).max(840).optional(),
  device_id: z.string().min(1).max(160).optional(),
  window_minutes: z.number().int().min(15).max(1440).optional(),
});

export const AccountingBillsSchema = z.object({
  start: z.string().describe("Inclusive ISO timestamp for processed AutoAccounting bills."),
  end: z.string().describe("Exclusive ISO timestamp for processed AutoAccounting bills."),
  device_id: z.string().min(1).max(160).optional(),
  transaction_types: z.array(z.enum(ACCOUNTING_TRANSACTION_TYPES)).max(10).optional(),
  category: z.string().max(100).optional(),
  keyword: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().max(500).optional(),
  refresh_from_android: z.boolean().optional()
    .describe("True by default. Ask the online Android integration to read AutoAccounting's completed bills before querying the server cache."),
});

const CoyoteDeviceSchema = z.object({
  device_id: z.string().min(1).max(160),
  request_id: z.string().regex(/^coyote_[a-f0-9-]{36}$/)
    .describe("Stable caller-generated idempotency ID. Reuse exactly for retries of the same physical command."),
});

const CoyoteChannelSchema = z.enum(["A", "B"]);
const CoyoteWaveformSchema = z.enum(COYOTE_WAVEFORMS);

export const CoyoteStatusSchema = z.object({
  device_id: z.string().min(1).max(160).optional(),
});

export const CoyoteStartSchema = CoyoteDeviceSchema.extend({
  channel: CoyoteChannelSchema,
  strength: z.number().int().min(0).max(10)
    .describe("Cold-start strength. Hard-limited to 10 before the Android user's own channel limit is applied."),
  waveform: CoyoteWaveformSchema,
  loop: z.boolean().optional(),
});

export const CoyoteAdjustSchema = CoyoteDeviceSchema.extend({
  channel: CoyoteChannelSchema,
  delta: z.number().int().min(-10).max(10)
    .describe("Relative strength change. Each call is hard-limited to plus or minus 10."),
});

export const CoyoteChangeWaveSchema = CoyoteDeviceSchema.extend({
  channel: CoyoteChannelSchema,
  waveform: CoyoteWaveformSchema,
  loop: z.boolean().optional(),
});

export const CoyoteStopSchema = CoyoteDeviceSchema.extend({
  channel: CoyoteChannelSchema.optional()
    .describe("Omit to stop both channels."),
});

export const CoyoteEmergencyStopSchema = CoyoteDeviceSchema;

export const CaptureScreenshotSchema = z.object({
  device_id: z.string().min(1).max(160),
  max_width: z.number().int().min(320).max(1080).optional()
    .describe("Maximum JPEG width. Defaults to 720."),
  jpeg_quality: z.number().int().min(35).max(85).optional()
    .describe("JPEG quality. Defaults to 65."),
  wait_seconds: z.number().int().min(0).max(20).optional()
    .describe("Event-driven wait for upload. Defaults to 12 seconds; 0 returns pending immediately."),
});

export const GetScreenshotSchema = z.object({
  screenshot_id: z.string().regex(/^shot_[a-f0-9-]{36}$/),
});

export const SendCommandsSchema = z.object({
  request_id: z.string().min(1).max(160).optional()
    .describe("Stable idempotency id for this one-shot action batch."),
  created_by: z.enum(["mcp", "supervision"]).optional()
    .describe("Use supervision only for automated supervision decisions; ordinary MCP callers should omit it."),
  commands: z.array(z.object({
    device_id: z.string().min(1).max(160).describe("Target device_id from live_dashboard.list_devices."),
    freeze_commands: z.array(z.string().max(120)).max(12).optional()
      .describe("Immediate one-shot freeze matches. Do not use for app time-limit policy."),
    unfreeze_commands: z.array(z.string().max(120)).max(12).optional()
      .describe("Immediate one-shot unfreeze matches; use [\"全部\"] to clear all freezes on capable Android LSP devices."),
    vibrate: z.boolean().optional().describe("Immediate vibration request; true/false only."),
    screen_off: z.boolean().optional().describe("Immediate screen-off request; only delivered when the target explicitly reports screen_off capability."),
    say: z.string().max(500).optional().describe("Immediate device-visible reminder text, not a policy rule."),
    expires_in_seconds: z.number().int().min(10).max(3600).optional()
      .describe("Command freshness TTL, not an automatic unfreeze duration."),
  }).describe("One immediate action for one device.")).min(1).max(20),
}).describe("Use for immediate one-shot device actions only. Do not use to save risk-app rules or app time limits.");

export const SupervisionPolicySchema = z.object({
  policy_owner: z.enum(["openclaw", "hermes", "custom"])
    .describe("Controller identity that authored this complete snapshot; must match the active controller persona."),
  strategy_reason: z.string().min(1).max(500)
    .describe("Controller-authored rationale grounded in the current target and evidence."),
  review_interval_minutes: z.number().int().min(5).max(240)
    .describe("Controller-authored periodic interval for automatically waking the controller to review current supervision state."),
  risk_app_regex: z.array(z.string().max(120)).max(12)
    .describe("Controller-authored persistent Android LSP review-trigger regexes. Matching requests review; it does not freeze by itself."),
  risk_trigger_minutes: z.number().int().min(1).max(55)
    .describe("Controller-authored minutes threshold before Android LSP requests controller review."),
  app_time_limits: z.array(z.object({
    app_regex: z.string().min(1).max(120).describe("Persistent app matching regex for local daily time-limit enforcement."),
    limit_minutes: z.number().int().min(1).max(55).describe("Persistent daily local usage limit in minutes."),
    reason: z.string().max(120).optional().describe("Optional reason shown in local freeze state."),
  })).max(12)
    .describe("Persistent app time-limit policy. Not a one-time freeze."),
  web_allowlist: z.object({
    allowed_domains: z.array(z.string().min(1).max(253)).max(64)
      .describe("Domains the system browser may open while active; a domain also allows its subdomains. Empty disables web filtering."),
    active_windows: z.array(z.object({
      days: z.array(z.number().int().min(1).max(7)).max(7).describe("ISO weekdays, 1 = Monday; empty means every day."),
      start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).describe("Phone-local start time, HH:MM."),
      end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).describe("Phone-local end time after start, HH:MM."),
    })).max(14)
      .describe("Optional windows; empty means whenever supervision is enabled."),
  }).optional()
    .describe("Strict Android LSP web allowlist: while active only the system browser runs, other browsers are paused, and it opens only these domains. Part of the complete snapshot; omitting it disables web filtering."),
  device_ids: z.array(z.string().min(1).max(160)).max(20).optional()
    .describe("Optional Android LSP device ids to sync; omit to sync all capable devices."),
  expires_in_seconds: z.number().int().min(10).max(3600).optional()
    .describe("Policy command delivery TTL, not the policy duration."),
}).describe("Delegated-controller interface for replacing the complete persistent strategy snapshot. Do not use for one-shot reminders or freezes.");

export const CommandStatusSchema = z.object({
  command_id: z.string().min(1).max(160).optional(),
  request_id: z.string().min(1).max(160).optional(),
});

export const ServiceSettingsUpdateSchema = z.object({
  target: z.string().max(1000).optional(),
  planned_rest: z.boolean().optional(),
  weekly_plan: z.array(z.object({
    weekday: z.number().int().min(1).max(7),
    target: z.string().max(1000).optional(),
    planned_rest: z.boolean().optional(),
  })).max(7).optional(),
  daily_summary_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  weekly_summary_weekday: z.number().int().min(1).max(7).optional(),
  weekly_summary_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  timezone_offset_minutes: z.number().int().min(-14 * 60).max(14 * 60).nullable().optional(),
  ai_deep_thinking: z.boolean().optional(),
  supervision_enabled: z.boolean().optional(),
  supervision_include_installed_apps: z.boolean().optional(),
  supervision_heuristic_triggers: z.boolean().optional(),
  supervision_blacklist_minutes: z.number().int().min(1).max(55).optional(),
  supervision_target_min_minutes: z.number().int().min(1).max(55).optional(),
  supervision_vibrate: z.boolean().optional(),
  supervision_skip_watch_sleep: z.boolean().optional(),
  supervision_lsp_freeze: z.boolean().optional(),
  client_updated_at: z.string().optional(),
}).describe("Server-side settings update for MCP/OpenClaw/Hermes controllers. Summary mode is intentionally excluded; use set_summary_mode.");

export const SetSummaryModeSchema = z.object({
  mode: z.enum(["gentle", "normal", "sharp"])
    .describe("Server-controlled summary/supervision tone. Phone settings cannot change this value."),
});

export const ControllerPersonaUpdateSchema = z.object({
  enabled: z.boolean().optional()
    .describe("true to apply controller persona to AI summary/supervision prompts; false disables it."),
  controller: z.enum(["openclaw", "hermes", "custom"]).optional()
    .describe("Controller family that owns the persona sync."),
  controller_name: z.string().max(80).optional()
    .describe("Human-readable controller name, for example OpenClaw or Hermes."),
  persona: z.string().max(4000).optional()
    .describe("Controller persona/profile text to keep Live Dashboard aligned with the controller."),
  relationship: z.string().max(1000).optional()
    .describe("Service relationship, such as subordinate/affiliate/delegated agent."),
  style_notes: z.string().max(1600).optional()
    .describe("Tone and wording notes for summaries, supervision, and reminders."),
}).describe("Sync OpenClaw/Hermes persona or subordinate relationship. Persona cannot override security, privacy, schema, or device capability constraints.");

export const ControllerMemoryFeedSchema = z.object({
  since: z.string().optional()
    .describe("Optional ISO timestamp; events at or after this time are returned. Prefer cursor for pagination."),
  cursor: z.string().optional()
    .describe("Opaque cursor returned as next_cursor. Prefer this over since for lossless pagination when many events share the same timestamp."),
  limit: z.number().int().min(1).max(300).optional()
    .describe("Maximum merged memory events to return. Defaults to 120."),
  include_messages: z.boolean().optional()
    .describe("true/false only. Include public/private/reply conversation messages. Defaults to true."),
  include_summaries: z.boolean().optional()
    .describe("true/false only. Include daily and weekly summaries. Defaults to true."),
  include_device_commands: z.boolean().optional()
    .describe("true/false only. Include reminders/device-control messages sent by the service. Defaults to true."),
}).describe("Controller memory feed for OpenClaw/Hermes. Use this to ingest sent messages, replies, summaries, and reminders into controller memory.");

export const SaveControllerSummarySchema = z.object({
  kind: z.enum(["daily_summary", "weekly_summary"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe("Required for daily_summary. For weekly_summary, this may be any date inside the target week."),
  week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe("Optional Monday week start for weekly_summary."),
  summary: z.string().min(1).max(4000)
    .describe("Controller-processed summary text. The server still sanitizes before saving."),
  mode: z.enum(["gentle", "normal", "sharp"]).optional()
    .describe("Tone metadata to store with the summary. Defaults to current service mode."),
  target: z.string().max(1000).optional()
    .describe("Optional target metadata to store with the summary. Defaults to current service target."),
}).describe("Persist an OpenClaw/Hermes-processed daily or weekly summary so controller memory/style is authoritative.");

export const StartAiJobSchema = z.object({
  request_id: z.string().min(1).max(160).optional(),
  kind: z.enum(["daily_summary", "weekly_summary", "supervision_rules_refresh", "supervision_check"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timezone_offset_minutes: z.number().int().min(-14 * 60).max(14 * 60).optional(),
  settings_updated_at: z.string().optional(),
  force: z.boolean().optional(),
  source: z.enum(["scheduled", "report"]).optional(),
  at: z.string().optional(),
}).describe("Start a long-running AI job and return its request_id for get_ai_job.");

export const AiJobStatusSchema = z.object({
  request_id: z.string().min(1).max(160),
});

export const CompleteControllerAiRequestSchema = z.object({
  request_id: z.string().min(1).max(160),
  claim_token: z.string().regex(/^claim_[a-f0-9-]{36}$/),
  outcome: z.enum(["succeeded", "failed", "skipped"]),
  detail: z.string().max(1000).optional(),
});

export const ClaimControllerAiRequestsSchema = z.object({
  owner_id: z.string().min(1).max(160),
  limit: z.number().int().min(1).max(20).optional(),
});

export const RunSupervisionCheckSchema = z.object({
  request_id: z.string().min(1).max(160).optional(),
  force: z.boolean().optional().describe("Default true. true ignores the scheduled interval but still respects supervision enabled and sleep guards."),
  source: z.enum(["scheduled", "report"]).optional()
    .describe("Defaults to report so manual OpenClaw/Hermes checks do not advance the scheduled supervision throttle."),
  at: z.string().optional().describe("Optional ISO timestamp to evaluate; omit for now."),
});

export type SendCommandsArgs = z.infer<typeof SendCommandsSchema>;
export type SupervisionPolicyArgs = z.infer<typeof SupervisionPolicySchema>;
