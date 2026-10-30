import { db } from "../db";
import { getDeviceContext } from "./device-context";
import { commandActions, type CommandStatus } from "./device-command-packages";
import { getCommandStatuses } from "./device-command-ledger";

// What Live can know about the apps frozen on an Android LSP phone. The phone's report lists at
// most eight frozen packages, so applied freeze results from the last day (a freeze lasts until
// the next local 03:00) fill in the rest. Each entry carries every text the phone matches an
// unfreeze pattern against: package name, app name, installed label and freeze reason.

export interface FrozenKnowledge {
  package_name: string;
  texts: string[];
}

const RESULT_LOOKBACK_MS = 24 * 60 * 60_000;
const recentFreezeCommandsStmt = db.prepare(`
  SELECT command_id FROM device_commands
  WHERE target_device_id = ? AND issued_at >= ? AND result_payload LIKE '%"freeze"%'
  ORDER BY issued_at DESC LIMIT 200
`);

export function knownFrozenPackages(deviceId: string, now = new Date()): Map<string, FrozenKnowledge> {
  const known = new Map<string, FrozenKnowledge>();
  const add = (packageName: string, ...texts: string[]) => {
    if (!packageName) return;
    const entry = known.get(packageName) ?? { package_name: packageName, texts: [packageName] };
    for (const text of texts) if (text && !entry.texts.includes(text)) entry.texts.push(text);
    known.set(packageName, entry);
  };
  for (const item of getDeviceContext(deviceId)?.frozen_packages ?? []) add(item.package_name, item.app_name, item.reason);
  const since = new Date(now.getTime() - RESULT_LOOKBACK_MS).toISOString();
  for (const row of recentFreezeCommandsStmt.all(deviceId, since) as { command_id: string }[]) {
    const command: CommandStatus | undefined = getCommandStatuses({ commandId: row.command_id }).commands[0];
    for (const action of commandActions(command)) {
      if (action.action === "freeze" && action.status === "applied" && Date.parse(action.until) > now.getTime()) {
        add(action.package_name, action.app_name);
      }
    }
  }
  return known;
}
