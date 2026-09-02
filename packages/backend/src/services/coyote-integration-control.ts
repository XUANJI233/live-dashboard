import { cleanIdentifier, cleanLooseIdentifier } from "./mcp-contracts";
import {
  coyoteCommandAllowed,
  coyoteRateLimitAllowed,
  normalizeCoyoteCommand,
  registerCoyoteRequest,
} from "./coyote-control";
import { androidIntegrationState, getCoyoteStatuses } from "./android-integration-state";
import { waitForAndroidIntegrationResult } from "./android-integration-broker";
import { realtimeSocketHub, sendJson } from "./realtime-socket-hub";

const COYOTE_COMMAND_TIMEOUT_MS = 5_000;

export { getCoyoteStatuses };

export async function executeCoyoteCommand(
  deviceIdInput: string,
  requestIdInput: string,
  commandInput: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const deviceId = cleanLooseIdentifier(deviceIdInput, 160);
  if (!deviceId) throw new Error("invalid_device_id");
  const requestId = cleanIdentifier(requestIdInput);
  if (!requestId || !/^coyote_[a-f0-9-]{36}$/.test(requestId)) throw new Error("invalid_coyote_request_id");
  const command = normalizeCoyoteCommand(commandInput);
  const state = androidIntegrationState(deviceId);
  const socket = realtimeSocketHub.getIntegrationSocket(deviceId);
  const grant = {
    online: !!socket,
    connected: state?.coyote.connected === true,
    remote_control_enabled: state?.coyote.remote_control_enabled === true,
  };
  if (!coyoteCommandAllowed(command.action, grant)) {
    return {
      ok: false,
      status: socket ? "denied" : "offline",
      error: socket ? "coyote_remote_control_not_granted_or_disconnected" : "android_integration_offline",
      device_id: deviceId,
      command,
    };
  }
  const requestRegistration = registerCoyoteRequest(deviceId, requestId, command);
  if (requestRegistration === "conflict") {
    return { ok: false, status: "conflict", error: "coyote_request_id_conflict", device_id: deviceId, request_id: requestId };
  }
  if (requestRegistration === "new" && !coyoteRateLimitAllowed(deviceId, command.action)) {
    return {
      ok: false,
      status: "rate_limited",
      error: "coyote_command_rate_limited",
      device_id: deviceId,
      command,
    };
  }
  const result = waitForAndroidIntegrationResult(requestId, deviceId, "coyote", COYOTE_COMMAND_TIMEOUT_MS, () => {
    sendJson(socket!, { type: "coyote_command", v: 1, request_id: requestId, command });
  });
  return { request_id: requestId, device_id: deviceId, command, ...await result };
}
