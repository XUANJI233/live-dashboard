import type { getCommandStatuses } from "./device-command-ledger";

// Android LSP runs freeze/unfreeze entries as case-insensitive Java regexes with find(), so a bare
// package name also hits its siblings ("com.taobao.taobao" matches "com.taobao.taobao.lite").
// Live's own per-package commands send an anchored, escaped pattern instead.

export type CommandStatus = ReturnType<typeof getCommandStatuses>["commands"][number];

export interface CommandAction {
  action: string;
  status: string;
  reason: string;
  package_name: string;
  app_name: string;
  until: string;
}

export const ANDROID_CATCH_ALL = new Set(["*", ".*", "全部", "全量", "所有", "all"]);

export function exactPackagePattern(packageName: string): string {
  return `^${packageName.replace(/[.$^\\]/g, (char) => `\\${char}`)}$`;
}

export function isCatchAll(pattern: string): boolean {
  return ANDROID_CATCH_ALL.has(pattern.replace(/\s+/g, "").toLowerCase());
}

export function commandActions(command: CommandStatus | undefined): CommandAction[] {
  const actions = (command?.result.payload as { actions?: unknown } | undefined)?.actions;
  if (!Array.isArray(actions)) return [];
  return actions.filter((item): item is Record<string, unknown> => !!item && typeof item === "object").map((item) => ({
    action: String(item.action ?? ""),
    status: String(item.status ?? ""),
    reason: String(item.reason ?? ""),
    package_name: String(item.package_name ?? ""),
    app_name: String(item.app_name ?? ""),
    until: String(item.until ?? ""),
  }));
}
