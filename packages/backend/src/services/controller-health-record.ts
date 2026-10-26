import { metaGet, metaSet } from "../db";

// Reachability signals recorded where Live already talks to the controller. Kept apart from
// controller-health.ts so the outbox and MCP route can record without importing device control.
export const CONTROLLER_LAST_ACK_KEY = "controller_last_ack_at";
export const CONTROLLER_LAST_FAILURE_KEY = "controller_last_failure_at";
export const CONTROLLER_LAST_ERROR_KEY = "controller_last_error";
export const CONTROLLER_LAST_MCP_KEY = "controller_last_mcp_at";
const MCP_RECORD_INTERVAL_MS = 60_000;

export function recordControllerDeliveryResult(at: string, sent: boolean, reason: string): void {
  if (sent) {
    metaSet(CONTROLLER_LAST_ACK_KEY, at);
    return;
  }
  metaSet(CONTROLLER_LAST_FAILURE_KEY, at);
  metaSet(CONTROLLER_LAST_ERROR_KEY, reason.slice(0, 80));
}

/** Called for every authorized external MCP request; writes at most once a minute. */
export function recordControllerMcpCall(now = new Date()): void {
  const last = Date.parse(metaGet(CONTROLLER_LAST_MCP_KEY) || "");
  if (Number.isFinite(last) && now.getTime() - last < MCP_RECORD_INTERVAL_MS) return;
  metaSet(CONTROLLER_LAST_MCP_KEY, now.toISOString());
}
