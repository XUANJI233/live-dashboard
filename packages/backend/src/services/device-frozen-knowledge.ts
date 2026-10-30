import { db } from "../db";
import { getDeviceContext } from "./device-context";
import { commandActions, type CommandStatus } from "./device-command-packages";
import { getCommandStatuses } from "./device-command-ledger";

// What Live can know about the apps frozen on an Android LSP phone. Older builds list at most
// eight frozen packages in a report, and a report can lag a command, so the last day's applied freeze and unfreeze results (a freeze
// lasts until the next local 03:00) fill in the rest, replayed in order so an app that was opened
// again drops out. Report entries come first: they are current. Each entry carries the texts the
// phone matches an unfreeze pattern against: package name, app name and freeze reason. The phone
// stores a freeze's reason from the command's `reason`, else its `say`.

export interface FrozenKnowledge {
  package_name: string;
  texts: string[];
}

const RESULT_LOOKBACK_MS = 24 * 60 * 60_000;
const STATUS_REASONS = new Set(["already_frozen", "ws", "http", ""]);
const recentFreezeCommandsStmt = db.prepare(`
  SELECT command_id FROM device_commands
  WHERE target_device_id = ? AND issued_at >= ?
    AND (result_payload LIKE '%"freeze"%' OR result_payload LIKE '%"unfreeze"%')
  ORDER BY issued_at DESC LIMIT 200
`);

export function knownFrozenPackages(deviceId: string, now = new Date()): Map<string, FrozenKnowledge> {
  const history = frozenFromResults(deviceId, now);
  const known = new Map<string, FrozenKnowledge>();
  for (const item of getDeviceContext(deviceId)?.frozen_packages ?? []) {
    if (!item.package_name) continue;
    known.set(item.package_name, entry(item.package_name, [...(history.get(item.package_name)?.texts ?? []), item.app_name, item.reason]));
  }
  // Most recently frozen first.
  for (const [name, value] of [...history].reverse()) if (!known.has(name)) known.set(name, value);
  return known;
}

/** Packages whose latest applied result in the last day is an unexpired freeze, oldest first. */
function frozenFromResults(deviceId: string, now: Date): Map<string, FrozenKnowledge> {
  const since = new Date(now.getTime() - RESULT_LOOKBACK_MS).toISOString();
  const rows = (recentFreezeCommandsStmt.all(deviceId, since) as { command_id: string }[]).reverse();
  const frozen = new Map<string, FrozenKnowledge>();
  for (const row of rows) {
    const command: CommandStatus | undefined = getCommandStatuses({ commandId: row.command_id }).commands[0];
    const reason = freezeReason(command);
    for (const action of commandActions(command)) {
      if (action.status !== "applied" || !action.package_name) continue;
      const name = action.package_name;
      if (action.action === "unfreeze") {
        frozen.delete(name);
      } else if (action.action === "freeze" && Date.parse(action.until) > now.getTime()) {
        // An adopted freeze keeps its original reason, which this command did not set.
        const kept = action.reason === "already_frozen" ? frozen.get(name)?.texts ?? [] : [];
        frozen.delete(name);
        frozen.set(name, entry(name, [...kept, action.app_name, action.reason === "already_frozen" ? "" : reason]));
      }
    }
  }
  return frozen;
}

function entry(packageName: string, texts: string[]): FrozenKnowledge {
  return { package_name: packageName, texts: [...new Set([packageName, ...texts.filter(Boolean)])] };
}

function freezeReason(command: CommandStatus | undefined): string {
  const payload = (command?.payload as { payload?: { reason?: unknown; say?: unknown } } | undefined)?.payload;
  const value = String(payload?.reason ?? "").trim() || String(payload?.say ?? "").trim();
  return STATUS_REASONS.has(value) ? "" : value;
}
