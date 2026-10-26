import { db, metaGet, metaSet } from "../db";
import { hermesControllerEnabled } from "./controller-mode";
import { controllerExplicitlyPaused } from "./controller-persona";
import { controllerWebhookEnabled } from "./controller-webhook";
import { getSummarySettings } from "./daily-summary-gen";
import { deviceSupportsCommand, listDeviceContexts } from "./device-context";
import { sendDeviceCommands } from "./device-control";
import {
  CONTROLLER_LAST_ACK_KEY,
  CONTROLLER_LAST_ERROR_KEY,
  CONTROLLER_LAST_FAILURE_KEY,
  CONTROLLER_LAST_MCP_KEY,
} from "./controller-health-record";

/**
 * Whether the external controller is reachable, recorded from what Live already does: webhook
 * deliveries (ACK or failure) and authenticated MCP calls. There is deliberately no automatic
 * failover; this only makes a dead controller visible and tells the user once in a while.
 */
const LAST_NUDGE_KEY = "controller_last_unreachable_nudge_at";
const UNREACHABLE_AFTER_MS = 30 * 60_000;
const RECENT_FAILURE_MS = 10 * 60_000;
const NUDGE_INTERVAL_MS = 6 * 60 * 60_000;
const UNREACHABLE_MESSAGE = "监督助手暂时联系不上，记录照常进行；恢复前不会收到它的提醒。";

export interface ControllerHealth {
  hermes_enabled: boolean;
  webhook_enabled: boolean;
  paused: boolean;
  last_ack_at: string | null;
  last_failure_at: string | null;
  last_error: string;
  last_mcp_at: string | null;
  pending_count: number;
  oldest_pending_at: string | null;
  dead_last_24h: number;
  unreachable: boolean;
}

const outboxStats = db.prepare(`
  SELECT
    SUM(CASE WHEN delivered_at IS NULL AND dead_at IS NULL THEN 1 ELSE 0 END) AS pending,
    MIN(CASE WHEN delivered_at IS NULL AND dead_at IS NULL THEN created_at END) AS oldest_pending,
    SUM(CASE WHEN dead_at IS NOT NULL AND julianday(dead_at) >= julianday(?) THEN 1 ELSE 0 END) AS dead_recent
  FROM controller_event_outbox
`);

export function controllerHealth(now = new Date()): ControllerHealth {
  const stats = outboxStats.get(new Date(now.getTime() - 24 * 60 * 60_000).toISOString()) as {
    pending: number | null;
    oldest_pending: string | null;
    dead_recent: number | null;
  };
  const lastAck = metaGet(CONTROLLER_LAST_ACK_KEY);
  const lastFailure = metaGet(CONTROLLER_LAST_FAILURE_KEY);
  const health: ControllerHealth = {
    hermes_enabled: hermesControllerEnabled(),
    webhook_enabled: controllerWebhookEnabled(),
    paused: controllerExplicitlyPaused(),
    last_ack_at: lastAck,
    last_failure_at: lastFailure,
    last_error: metaGet(CONTROLLER_LAST_ERROR_KEY) || "",
    last_mcp_at: metaGet(CONTROLLER_LAST_MCP_KEY),
    pending_count: stats.pending ?? 0,
    oldest_pending_at: stats.oldest_pending,
    dead_last_24h: stats.dead_recent ?? 0,
    unreachable: false,
  };
  health.unreachable = controllerUnreachable(health, now);
  return health;
}

/**
 * Live is actively trying to reach the controller, the latest attempt failed, and no ACK has
 * arrived for half an hour. A quiet controller with nothing to deliver is not unreachable.
 */
function controllerUnreachable(health: ControllerHealth, now: Date): boolean {
  if (!health.hermes_enabled || !health.webhook_enabled) return false;
  const failureMs = Date.parse(health.last_failure_at || "");
  if (!Number.isFinite(failureMs) || now.getTime() - failureMs > RECENT_FAILURE_MS) return false;
  const ackMs = Date.parse(health.last_ack_at || "");
  if (Number.isFinite(ackMs) && ackMs >= failureMs) return false;
  return !Number.isFinite(ackMs) || now.getTime() - ackMs >= UNREACHABLE_AFTER_MS;
}

/** At most once every six hours, tell the phone that supervision is not reaching its controller. */
export function maybeNudgeUnreachableController(now = new Date()): boolean {
  const settings = getSummarySettings();
  if (!settings.supervision_enabled) return false;
  const health = controllerHealth(now);
  if (!health.unreachable || health.paused) return false;
  const lastNudge = Date.parse(metaGet(LAST_NUDGE_KEY) || "");
  if (Number.isFinite(lastNudge) && now.getTime() - lastNudge < NUDGE_INTERVAL_MS) return false;
  const phones = listDeviceContexts()
    .filter((device) => device.is_online && device.platform === "android" && deviceSupportsCommand(device, "say"));
  if (phones.length === 0) return false;
  metaSet(LAST_NUDGE_KEY, now.toISOString());
  sendDeviceCommands({
    created_by: "supervision",
    commands: phones.map((device) => ({ device_id: device.device_id, say: UNREACHABLE_MESSAGE })),
  });
  return true;
}
