import { cleanLooseIdentifier } from "./mcp-contracts";
import { waitForAndroidIntegrationResult } from "./android-integration-broker";
import { realtimeSocketHub, sendJson } from "./realtime-socket-hub";

const ACCOUNTING_SYNC_TIMEOUT_MS = 60_000;
const MAX_ACCOUNTING_RANGE_MS = 3_650 * 24 * 60 * 60_000;

export async function requestAccountingSync(options: {
  deviceId?: string;
  start: string;
  end: string;
}): Promise<Record<string, unknown>> {
  const startMs = Date.parse(options.start);
  const endMs = Date.parse(options.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error("invalid_accounting_range");
  }
  if (endMs - startMs > MAX_ACCOUNTING_RANGE_MS) throw new Error("accounting_range_too_large");
  const requestedDeviceId = cleanLooseIdentifier(options.deviceId, 160);
  const deviceIds = requestedDeviceId ? [requestedDeviceId] : realtimeSocketHub.onlineIntegrationDeviceIds();
  if (deviceIds.length === 0) {
    return {
      ok: false,
      status: "offline",
      error: "android_integration_offline",
      device_id: requestedDeviceId || null,
      devices: [],
    };
  }
  const results = await Promise.all(deviceIds.map((deviceId) => requestForDevice(deviceId, options)));
  const succeeded = results.filter((item) => item.ok === true).length;
  return {
    ok: succeeded === results.length,
    status: succeeded === results.length ? "applied" : succeeded > 0 ? "partial" : results[0]?.status ?? "failed",
    device_id: requestedDeviceId || null,
    devices: results,
  };
}

async function requestForDevice(
  deviceId: string,
  options: { start: string; end: string },
): Promise<Record<string, unknown>> {
  const socket = realtimeSocketHub.getIntegrationSocket(deviceId);
  if (!socket) {
    return { ok: false, status: "offline", error: "android_integration_offline", device_id: deviceId };
  }
  const requestId = `accounting_${crypto.randomUUID()}`;
  const result = waitForAndroidIntegrationResult(requestId, deviceId, "accounting", ACCOUNTING_SYNC_TIMEOUT_MS, () => {
    sendJson(socket, {
      type: "accounting_sync_request",
      v: 1,
      request_id: requestId,
      start: options.start,
      end: options.end,
    });
  });
  return { request_id: requestId, device_id: deviceId, ...await result };
}
