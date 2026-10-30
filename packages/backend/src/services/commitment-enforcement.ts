import { getDeviceContext } from "./device-context";
import { sendDeviceCommands } from "./device-control";
import { getCommandStatuses } from "./device-command-ledger";
import { commandActions, exactPackagePattern, type CommandStatus } from "./device-command-packages";
import { committedDevices, lockedPackages } from "./commitments";
import {
  emptyPackageState,
  forgetPackageState,
  packageStates,
  savePackageState,
  trackedDevices,
  type PackageStateRow,
} from "./commitment-sync-store";

// Runs every minute and reconciles each phone with its committed packages, so a commitment holds
// without a controller waking up. Each package gets its own exact command, and only that
// command's result moves the package state: the phone's report lists at most eight frozen apps
// and scans only sixteen records per unfreeze, so batch patterns and the report cannot confirm a
// 17-app rule. A freeze lasts until the phone's own `until` (its next local 03:00); a package
// that leaves the desired set is released and retried until the phone confirms it.

const PENDING_TIMEOUT_MS = 3 * 60_000;
const FAILURE_BACKOFF_MS = 10 * 60_000;
const ABSENT_BACKOFF_MS = 60 * 60_000;
const UNKNOWN_EXPIRY_RECHECK_MS = 60 * 60_000;
const RELEASE_RETRY_MS = 2 * 60_000;
const MAX_RELEASE_ATTEMPTS = 4;
const PHONE_REPORT_LIMIT = 8;
const REPORT_SETTLE_MS = 30_000;
const MAX_COMMANDS_PER_REQUEST = 20;

export interface EnforcementResult {
  freeze_requests: number;
  unfreeze_requests: number;
}

export function enforceCommitments(now = new Date()): EnforcementResult {
  const result: EnforcementResult = { freeze_requests: 0, unfreeze_requests: 0 };
  for (const deviceId of new Set([...committedDevices(now), ...trackedDevices()])) {
    syncDevice(deviceId, now, result);
  }
  return result;
}

/** Record what an exception's own unfreeze did, so the loop neither re-sends nor misses it. */
export function noteExceptionUnfreeze(deviceId: string, packageName: string, command: CommandStatus | undefined, now = new Date()): void {
  const state = packageStates(deviceId).get(packageName) ?? emptyPackageState(deviceId, packageName, now.toISOString());
  if (!command) return;
  Object.assign(state, {
    pending_command_id: command.command_id,
    pending_action: "release",
    pending_sent_at: now.toISOString(),
    updated_at: now.toISOString(),
  });
  absorbResult(state, command, now);
}

function syncDevice(deviceId: string, now: Date, result: EnforcementResult): void {
  const states = packageStates(deviceId);
  for (const [name, state] of states) states.set(name, absorbPending(state, now));
  const desired = lockedPackages(deviceId, now);
  const device = getDeviceContext(deviceId);
  if (!device?.is_online) return;

  const reported = new Set(device.frozen_packages.map((item) => item.package_name));
  const reportComplete = device.frozen_packages.length < PHONE_REPORT_LIMIT;
  const reportedAt = Date.parse(device.last_seen_at);
  const freeze: PackageStateRow[] = [];
  const release: PackageStateRow[] = [];
  for (const name of desired) {
    const state = states.get(name) ?? emptyPackageState(deviceId, name, now.toISOString());
    if (inFlight(state, now) || backingOff(state, now)) continue;
    // A complete, newer report that no longer lists the package means the phone dropped it.
    const dropped = reportComplete && !reported.has(name) && reportedAt > Date.parse(state.confirmed_at) + REPORT_SETTLE_MS;
    if (frozenKnown(state, now) && !dropped) continue;
    freeze.push(state);
  }
  for (const state of states.values()) {
    if (desired.has(state.package_name) || inFlight(state, now)) continue;
    if (!frozenKnown(state, now)) forgetPackageState(deviceId, state.package_name);
    else if (!backingOff(state, now)) release.push(state);
  }
  result.freeze_requests += send(deviceId, freeze, "freeze", now);
  result.unfreeze_requests += send(deviceId, release, "release", now);
}

function send(deviceId: string, states: PackageStateRow[], action: "freeze" | "release", now: Date): number {
  let requests = 0;
  for (let index = 0; index < states.length; index += MAX_COMMANDS_PER_REQUEST) {
    const chunk = states.slice(index, index + MAX_COMMANDS_PER_REQUEST);
    const sent = sendDeviceCommands({
      request_id: `commitment-sync-${crypto.randomUUID()}`,
      created_by: "supervision",
      commands: chunk.map((state) => ({
        device_id: deviceId,
        ...(action === "freeze"
          ? { freeze_commands: [exactPackagePattern(state.package_name)] }
          : { unfreeze_commands: [exactPackagePattern(state.package_name)] }),
      })),
    }, { bypassCommitments: true });
    chunk.forEach((state, position) => {
      savePackageState({
        ...state,
        pending_command_id: sent.commands[position]?.command_id ?? "",
        pending_action: action,
        pending_sent_at: now.toISOString(),
        updated_at: now.toISOString(),
      });
    });
    requests += 1;
  }
  return requests;
}

function absorbPending(state: PackageStateRow, now: Date): PackageStateRow {
  if (!state.pending_command_id) return state;
  const command = getCommandStatuses({ commandId: state.pending_command_id }).commands[0];
  const waiting = command?.result.status === "unknown" && now.getTime() - Date.parse(state.pending_sent_at) < PENDING_TIMEOUT_MS;
  return waiting ? state : absorbResult(state, command, now);
}

function absorbResult(state: PackageStateRow, command: CommandStatus | undefined, now: Date): PackageStateRow {
  if (command?.result.status === "unknown" && command.delivery.status === "sent") {
    // Still on its way: keep it pending; absorbPending picks the answer up.
    savePackageState(state);
    return state;
  }
  const kind = state.pending_action === "freeze" ? "freeze" : "unfreeze";
  const actions = commandActions(command).filter((item) => item.action === kind);
  const applied = actions.find((item) => item.status === "applied");
  const at = now.toISOString();
  const next: PackageStateRow = { ...state, pending_command_id: "", pending_action: "", pending_sent_at: "", updated_at: at };
  if (kind === "freeze") {
    if (applied) {
      const until = Date.parse(applied.until);
      next.frozen_until = Number.isFinite(until) ? applied.until : new Date(now.getTime() + UNKNOWN_EXPIRY_RECHECK_MS).toISOString();
      next.confirmed_at = command?.result.result_at || at;
      next.retry_after = "";
    } else {
      const absent = actions.some((item) => item.reason === "no_installed_or_foreground_app_matched");
      next.retry_after = new Date(now.getTime() + (absent ? ABSENT_BACKOFF_MS : FAILURE_BACKOFF_MS)).toISOString();
    }
  } else if (applied) {
    next.frozen_until = "";
    next.release_attempts = 0;
    next.confirmed_at = command?.result.result_at || at;
  } else {
    // "no_frozen_app_matched" can also mean the record sat beyond the phone's 16-record scan,
    // so it is retried like any other miss; after the last attempt Live stops tracking it.
    next.release_attempts = state.release_attempts + 1;
    if (next.release_attempts >= MAX_RELEASE_ATTEMPTS) next.frozen_until = "";
    else next.retry_after = new Date(now.getTime() + RELEASE_RETRY_MS).toISOString();
  }
  savePackageState(next);
  return next;
}

function inFlight(state: PackageStateRow, now: Date): boolean {
  return !!state.pending_command_id && now.getTime() - Date.parse(state.pending_sent_at) < PENDING_TIMEOUT_MS;
}

function backingOff(state: PackageStateRow, now: Date): boolean {
  return !!state.retry_after && Date.parse(state.retry_after) > now.getTime();
}

function frozenKnown(state: PackageStateRow, now: Date): boolean {
  return !!state.frozen_until && Date.parse(state.frozen_until) > now.getTime();
}
