import { cleanLooseIdentifier, cleanText } from "./mcp-contracts";
import { realtimeSocketHub } from "./realtime-socket-hub";

export interface CoyoteIntegrationState {
  available: boolean;
  connected: boolean;
  device_name: string;
  generation: "v2" | "v3" | "unknown";
  battery_percent: number | null;
  strength_a: number;
  strength_b: number;
  limit_a: number;
  limit_b: number;
  wave_active_a: boolean;
  wave_active_b: boolean;
  waveform_a: string;
  waveform_b: string;
  remote_control_enabled: boolean;
}

export interface AndroidIntegrationState {
  device_id: string;
  online: boolean;
  updated_at: string;
  coyote: CoyoteIntegrationState;
  accounting: {
    available: boolean;
    last_sync_at: string;
    last_error: string;
  };
}

const states = new Map<string, AndroidIntegrationState>();

export function updateAndroidIntegrationState(
  deviceIdInput: string,
  data: Record<string, unknown>,
): AndroidIntegrationState {
  const deviceId = cleanLooseIdentifier(deviceIdInput, 160);
  const previous = states.get(deviceId) ?? emptyIntegrationState(deviceId);
  const coyoteBody = objectField(data.coyote) ?? objectField(data.state);
  const accountingBody = objectField(data.accounting);
  const next = {
    device_id: deviceId,
    online: true,
    updated_at: new Date().toISOString(),
    coyote: coyoteBody ? normalizeCoyoteState(coyoteBody, previous.coyote) : previous.coyote,
    accounting: accountingBody ? normalizeAccountingState(accountingBody, previous.accounting) : previous.accounting,
  };
  states.set(deviceId, next);
  return next;
}

export function markAndroidIntegrationOffline(deviceIdInput: string): void {
  const deviceId = cleanLooseIdentifier(deviceIdInput, 160);
  const previous = states.get(deviceId);
  if (!previous) return;
  states.set(deviceId, { ...previous, online: false, updated_at: new Date().toISOString() });
}

export function androidIntegrationState(deviceId: string): AndroidIntegrationState | undefined {
  return states.get(deviceId);
}

export function getCoyoteStatuses(deviceIdInput?: string): {
  generated_at: string;
  devices: AndroidIntegrationState[];
} {
  const deviceId = cleanLooseIdentifier(deviceIdInput, 160);
  const devices = Array.from(states.values())
    .filter((item) => !deviceId || item.device_id === deviceId)
    .map((item) => ({
      ...item,
      online: realtimeSocketHub.getIntegrationSocket(item.device_id) != null,
    }));
  return { generated_at: new Date().toISOString(), devices };
}

function normalizeCoyoteState(
  body: Record<string, unknown>,
  previous: CoyoteIntegrationState,
): CoyoteIntegrationState {
  const generation = body.generation === "v2" || body.generation === "v3" ? body.generation : "unknown";
  return {
    available: strictBoolean(body.available, previous.available),
    connected: strictBoolean(body.connected, previous.connected),
    device_name: cleanText(body.device_name, 100),
    generation,
    battery_percent: nullableNumber(body.battery_percent, 0, 100),
    strength_a: integer(body.strength_a, 0, 200, previous.strength_a),
    strength_b: integer(body.strength_b, 0, 200, previous.strength_b),
    limit_a: integer(body.limit_a, 0, 200, previous.limit_a),
    limit_b: integer(body.limit_b, 0, 200, previous.limit_b),
    wave_active_a: strictBoolean(body.wave_active_a, previous.wave_active_a),
    wave_active_b: strictBoolean(body.wave_active_b, previous.wave_active_b),
    waveform_a: cleanText(body.waveform_a, 40),
    waveform_b: cleanText(body.waveform_b, 40),
    remote_control_enabled: strictBoolean(body.remote_control_enabled, previous.remote_control_enabled),
  };
}

function normalizeAccountingState(
  body: Record<string, unknown>,
  previous: AndroidIntegrationState["accounting"],
): AndroidIntegrationState["accounting"] {
  return {
    available: strictBoolean(body.available, previous.available),
    last_sync_at: cleanText(body.last_sync_at, 40),
    last_error: cleanText(body.last_error, 240),
  };
}

function emptyIntegrationState(deviceId: string): AndroidIntegrationState {
  return {
    device_id: deviceId,
    online: false,
    updated_at: "",
    coyote: {
      available: false,
      connected: false,
      device_name: "",
      generation: "unknown",
      battery_percent: null,
      strength_a: 0,
      strength_b: 0,
      limit_a: 50,
      limit_b: 50,
      wave_active_a: false,
      wave_active_b: false,
      waveform_a: "",
      waveform_b: "",
      remote_control_enabled: false,
    },
    accounting: { available: false, last_sync_at: "", last_error: "" },
  };
}

function objectField(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strictBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function integer(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

function nullableNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : null;
}
