export const COYOTE_WAVEFORMS = ["breath", "tide", "pulse_low", "pulse_mid", "pulse_high", "tap"] as const;
export type CoyoteWaveform = typeof COYOTE_WAVEFORMS[number];
export type CoyoteAction = "start" | "adjust" | "change_wave" | "stop" | "emergency_stop";
export type CoyoteChannel = "A" | "B";

const MAX_COLD_START_STRENGTH = 10;
const MAX_ADJUST_STEP = 10;
const RATE_WINDOW_MS = 5_000;
const actionHistory = new Map<string, number[]>();
const requestFingerprints = new Map<string, string>();
const MAX_REQUEST_FINGERPRINTS = 1_000;

export interface CoyoteCommand {
  action: CoyoteAction;
  channel?: CoyoteChannel;
  strength?: number;
  delta?: number;
  waveform?: CoyoteWaveform;
  loop?: boolean;
}

export interface CoyoteGrantState {
  online: boolean;
  connected: boolean;
  remote_control_enabled: boolean;
}

export function normalizeCoyoteCommand(value: Record<string, unknown>): CoyoteCommand {
  const action = coyoteAction(value.action);
  const channel = value.channel === "B" ? "B" : "A";
  if (action === "start") {
    return {
      action,
      channel,
      strength: boundedInteger(value.strength, 0, MAX_COLD_START_STRENGTH, 0),
      waveform: coyoteWaveform(value.waveform),
      loop: value.loop !== false,
    };
  }
  if (action === "adjust") {
    return {
      action,
      channel,
      delta: boundedInteger(value.delta, -MAX_ADJUST_STEP, MAX_ADJUST_STEP, 0),
    };
  }
  if (action === "change_wave") {
    return {
      action,
      channel,
      waveform: coyoteWaveform(value.waveform),
      loop: value.loop !== false,
    };
  }
  if (action === "stop") {
    return { action, ...(value.channel === "A" || value.channel === "B" ? { channel: value.channel } : {}) };
  }
  return { action: "emergency_stop" };
}

export function coyoteCommandAllowed(action: CoyoteAction, state: CoyoteGrantState): boolean {
  if (action === "stop" || action === "emergency_stop") return state.online;
  return state.online && state.connected && state.remote_control_enabled;
}

export function coyoteRateLimitAllowed(deviceId: string, action: CoyoteAction, now = Date.now()): boolean {
  const cap = action === "adjust" ? 2 : action === "start" || action === "change_wave" ? 1 : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(cap)) return true;
  const key = `${deviceId}:${action}`;
  const recent = (actionHistory.get(key) ?? []).filter((timestamp) => timestamp >= now - RATE_WINDOW_MS);
  if (recent.length >= cap) {
    actionHistory.set(key, recent);
    return false;
  }
  recent.push(now);
  actionHistory.set(key, recent);
  return true;
}

export function inspectCoyoteRequest(
  deviceId: string,
  requestId: string,
  command: CoyoteCommand,
): "new" | "retry" | "conflict" {
  const key = `${deviceId}:${requestId}`;
  const fingerprint = JSON.stringify(command);
  const existing = requestFingerprints.get(key);
  if (existing != null) return existing === fingerprint ? "retry" : "conflict";
  return "new";
}

export function rememberCoyoteRequest(
  deviceId: string,
  requestId: string,
  command: CoyoteCommand,
): void {
  const key = `${deviceId}:${requestId}`;
  requestFingerprints.set(key, JSON.stringify(command));
  while (requestFingerprints.size > MAX_REQUEST_FINGERPRINTS) {
    const oldest = requestFingerprints.keys().next().value as string | undefined;
    if (!oldest) break;
    requestFingerprints.delete(oldest);
  }
}

function coyoteAction(value: unknown): CoyoteAction {
  return value === "start" || value === "adjust" || value === "change_wave" || value === "stop"
    ? value
    : "emergency_stop";
}

function coyoteWaveform(value: unknown): CoyoteWaveform {
  return (COYOTE_WAVEFORMS as readonly unknown[]).includes(value)
    ? value as CoyoteWaveform
    : "pulse_mid";
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
