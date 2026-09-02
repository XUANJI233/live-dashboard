import type { ServerWebSocket } from "bun";
import { cleanIdentifier } from "./mcp-contracts";
import { settleAndroidIntegrationResult } from "./android-integration-broker";
import {
  updateAndroidIntegrationState,
} from "./android-integration-state";
import { sendJson } from "./realtime-socket-hub";
import type { WsData } from "./realtime-types";

export { requestAccountingSync } from "./accounting-integration-control";
export { executeCoyoteCommand, getCoyoteStatuses } from "./coyote-integration-control";
export { markAndroidIntegrationOffline } from "./android-integration-state";

export function handleAndroidIntegrationWsMessage(
  ws: ServerWebSocket<WsData>,
  data: Record<string, unknown>,
): void {
  if (data.v !== 1) {
    sendJson(ws, { type: "error", v: 1, error: "unsupported_integration_version" });
    return;
  }
  if (data.type === "integration_status") {
    const state = updateAndroidIntegrationState(ws.data.id, data);
    sendJson(ws, { type: "integration_status_received", v: 1, received: true, updated_at: state.updated_at });
    return;
  }
  if (data.type === "coyote_command_result") {
    updateAndroidIntegrationState(ws.data.id, data);
    settleAndroidIntegrationResult(ws.data.id, cleanRequestId(data.request_id), "coyote", data);
    sendJson(ws, { type: "coyote_command_result_received", v: 1, request_id: cleanRequestId(data.request_id) });
    return;
  }
  if (data.type === "accounting_sync_result") {
    updateAndroidIntegrationState(ws.data.id, data);
    settleAndroidIntegrationResult(ws.data.id, cleanRequestId(data.request_id), "accounting", data);
    sendJson(ws, { type: "accounting_sync_result_received", v: 1, request_id: cleanRequestId(data.request_id) });
    return;
  }
  sendJson(ws, { type: "error", v: 1, error: "unsupported_integration_message" });
}

function cleanRequestId(value: unknown): string {
  return cleanIdentifier(value);
}
