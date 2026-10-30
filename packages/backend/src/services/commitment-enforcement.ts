import { getDeviceContext } from "./device-context";
import { sendDeviceCommands } from "./device-control";
import { getCommandStatuses } from "./device-command-ledger";
import { commandActions, exactPackagePattern, type CommandStatus } from "./device-command-packages";
import { committedDevices, lockedPackages, refundException } from "./commitments";
import {
  emptyPackageState,
  forgetPackageState,
  packageState,
  packageStates,
  savePackageState,
  trackedDevices,
  type PackageStateRow,
} from "./commitment-sync-store";

// Runs every minute and reconciles each phone with its committed packages, so a commitment holds
// without a controller waking up. Each package gets its own exact command, and only that
// command's result moves the package state: older phone builds list at most eight frozen apps
// and scan only sixteen records per unfreeze, so batch patterns and the report cannot confirm a
// 17-app rule. Current builds list every freeze with a total, which makes a drop visible. A freeze lasts until the phone's own `until` (its next local 03:00). A package that
// leaves the desired set is released, if Live froze it, and re-sent until the phone answers.
// Older builds keep at most sixteen unsent events (current ones 64), a receipt and a result per
// command, dropping the oldest, so Live keeps only a few commands outstanding per phone; the rest
// follow on later ticks.

// Long enough for a phone whose socket is down to fetch a queued command on its next HTTP report.
export const COMMITMENT_COMMAND_TTL_SECONDS = 10 * 60;
const PENDING_TIMEOUT_MS = COMMITMENT_COMMAND_TTL_SECONDS * 1000;
const FAILURE_BACKOFF_MS = 10 * 60_000;
const ABSENT_BACKOFF_MS = 60 * 60_000;
const UNKNOWN_EXPIRY_RECHECK_MS = 60 * 60_000;
const RELEASE_RETRY_MS = 2 * 60_000;
const MAX_RELEASE_ATTEMPTS = 4;
const LEGACY_REPORT_LIMIT = 8;
const REPORT_SETTLE_MS = 30_000;
// Twelve events of an older phone's sixteen, leaving room for a controller's own commands.
const MAX_OUTSTANDING_COMMANDS = 6;
// A phone freeze lasts until its next local 03:00, so it was placed within a day before `until`.
const FREEZE_LIFETIME_MS = 24 * 60 * 60_000;

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

/**
 * Track an exception's own unfreeze like any release, so a late result is absorbed and the
 * exception's quota is refunded if the phone never applies it. Returns the settled state.
 */
export function noteExceptionUnfreeze(
  deviceId: string,
  packageName: string,
  command: CommandStatus,
  exceptionGroup: string,
  now = new Date(),
): PackageStateRow {
  const state = packageStates(deviceId).get(packageName) ?? emptyPackageState(deviceId, packageName, now.toISOString());
  return absorbResult({
    ...state,
    pending_command_id: command.command_id,
    pending_action: "release",
    pending_sent_at: now.toISOString(),
    exception_group: exceptionGroup,
    updated_at: now.toISOString(),
  }, command, now);
}

/** Whether a Live command for this package still waits on the phone, after taking in any answer. */
export function packageCommandPending(deviceId: string, packageName: string, now = new Date()): boolean {
  const state = packageState(deviceId, packageName);
  return !!state && inFlight(absorbPending(state, now), now);
}

function syncDevice(deviceId: string, now: Date, result: EnforcementResult): void {
  const states = packageStates(deviceId);
  for (const [name, state] of states) states.set(name, absorbPending(state, now));
  const desired = lockedPackages(deviceId, now);
  const device = getDeviceContext(deviceId);
  if (!device?.is_online) return;

  const reported = new Set(device.frozen_packages.map((item) => item.package_name));
  const total = device.frozen_packages_total;
  const reportComplete = total === null
    ? device.frozen_packages.length < LEGACY_REPORT_LIMIT
    : device.frozen_packages.length >= total;
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
    // Someone else's freeze (a controller, the phone's own time limit) is theirs to lift.
    if (!frozenKnown(state, now) || !state.owned) forgetPackageState(deviceId, state.package_name);
    else if (!backingOff(state, now)) release.push(state);
  }
  // Freezes go first; whatever does not fit is sent on a later tick.
  let room = MAX_OUTSTANDING_COMMANDS - [...states.values()].filter((state) => inFlight(state, now)).length;
  const take = (wanted: PackageStateRow[]) => {
    const chosen = wanted.slice(0, Math.max(0, room));
    room -= chosen.length;
    return chosen;
  };
  result.freeze_requests += send(deviceId, take(freeze), "freeze", now);
  result.unfreeze_requests += send(deviceId, take(release), "release", now);
}

function send(deviceId: string, states: PackageStateRow[], action: "freeze" | "release", now: Date): number {
  if (states.length === 0) return 0;
  const sent = sendDeviceCommands({
    request_id: `commitment-sync-${crypto.randomUUID()}`,
    created_by: "supervision",
    commands: states.map((state) => ({
      device_id: deviceId,
      expires_in_seconds: COMMITMENT_COMMAND_TTL_SECONDS,
      ...(action === "freeze"
        ? { freeze_commands: [exactPackagePattern(state.package_name)] }
        : { unfreeze_commands: [exactPackagePattern(state.package_name)] }),
    })),
  }, { bypassCommitments: true });
  states.forEach((state, position) => {
    savePackageState({
      ...state,
      pending_command_id: sent.commands[position]?.command_id ?? "",
      pending_action: action,
      pending_sent_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
  });
  return 1;
}

function absorbPending(state: PackageStateRow, now: Date): PackageStateRow {
  if (!state.pending_command_id) return state;
  const command = getCommandStatuses({ commandId: state.pending_command_id }).commands[0];
  return awaitingAnswer(command, state, now) ? state : absorbResult(state, command, now);
}

function absorbResult(state: PackageStateRow, command: CommandStatus | undefined, now: Date): PackageStateRow {
  if (awaitingAnswer(command, state, now)) {
    // Sent or queued and not expired: keep it pending; a later tick takes the answer in.
    savePackageState(state);
    return state;
  }
  const kind = state.pending_action === "freeze" ? "freeze" : "unfreeze";
  const actions = commandActions(command).filter((item) => item.action === kind);
  const applied = actions.find((item) => item.status === "applied");
  // Only the phone fills in per-package actions; a timeout or skip is not an answer.
  const phoneAnswered = actions.length > 0;
  const at = now.toISOString();
  const next: PackageStateRow = { ...state, pending_command_id: "", pending_action: "", pending_sent_at: "", updated_at: at };
  if (kind === "freeze") {
    if (applied) {
      const until = Date.parse(applied.until);
      // A freeze that was already there is someone else's, unless it is Live's own: one Live already
      // tracks, or one placed by an earlier Live freeze whose answer never came back.
      const own = frozenKnown(state, now) ? !!state.owned : lostFreezeCouldHold(state, until);
      next.owned = applied.reason === "already_frozen" && !own ? 0 : 1;
      next.frozen_until = Number.isFinite(until) ? applied.until : new Date(now.getTime() + UNKNOWN_EXPIRY_RECHECK_MS).toISOString();
      next.confirmed_at = command?.result.result_at || at;
      next.retry_after = "";
      next.unanswered_freeze_at = "";
    } else {
      const absent = actions.some((item) => item.reason === "no_installed_or_foreground_app_matched");
      next.retry_after = new Date(now.getTime() + (absent ? ABSENT_BACKOFF_MS : FAILURE_BACKOFF_MS)).toISOString();
      // Delivered but never answered: the phone may have frozen it and lost the result.
      const delivered = command?.delivery.status === "sent" || command?.delivery.status === "queued";
      if (delivered && !phoneAnswered) next.unanswered_freeze_at = state.pending_sent_at;
    }
  } else if (applied) {
    // Released. If the package is still wanted frozen (no open exception), the next tick re-freezes it.
    next.frozen_until = "";
    next.owned = 1;
    next.release_attempts = 0;
    next.exception_group = "";
    next.unanswered_freeze_at = "";
    next.confirmed_at = command?.result.result_at || at;
  } else {
    if (state.exception_group) {
      // The exception never opened the app: give its quota back.
      refundException(state.exception_group);
      next.exception_group = "";
    }
    if (phoneAnswered) {
      // "no_frozen_app_matched" can also mean the record sat beyond the phone's 16-record scan.
      next.release_attempts = state.release_attempts + 1;
      if (next.release_attempts >= MAX_RELEASE_ATTEMPTS) next.frozen_until = "";
    }
    if (next.frozen_until) next.retry_after = new Date(now.getTime() + RELEASE_RETRY_MS).toISOString();
  }
  savePackageState(next);
  return next;
}

function awaitingAnswer(command: CommandStatus | undefined, state: PackageStateRow, now: Date): boolean {
  if (!command || command.result.status !== "unknown") return false;
  const delivered = command.delivery.status === "sent" || command.delivery.status === "queued";
  return delivered && now.getTime() - Date.parse(state.pending_sent_at) < PENDING_TIMEOUT_MS;
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

/** Could Live's unanswered freeze be the one that lasts until `until`? */
function lostFreezeCouldHold(state: PackageStateRow, until: number): boolean {
  const sentAt = Date.parse(state.unanswered_freeze_at);
  if (!Number.isFinite(sentAt)) return false;
  return !Number.isFinite(until) || (sentAt < until && sentAt > until - FREEZE_LIFETIME_MS);
}
