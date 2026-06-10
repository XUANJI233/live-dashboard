import type { SupervisionRules } from "./daily-summary-gen";
import { parseAiJsonObject } from "./ai-json";
import { normalizeSupervisionPatternList } from "./supervision-patterns";

export interface SupervisionCommandDecision {
  device_id: string;
  deviated: boolean;
  message: string;
  reason: string;
  vibrate: boolean;
  freeze: boolean;
  freeze_commands: string[];
  screen_off: boolean;
  unfreeze: boolean;
  unfreeze_commands: string[];
}

export interface SupervisionDecision extends Omit<SupervisionCommandDecision, "device_id"> {
  device_decisions: SupervisionCommandDecision[];
}

export function parseRulesResponse(raw: string): SupervisionRules {
  const parsed = parseAiJsonObject(raw);
  const whitelist = parsed.whitelist_app_regex;
  const blacklist = parsed.blacklist_app_regex;
  const risk = parsed.risk_app_regex;
  const target = parsed.target_app_regex;
  if (!Array.isArray(whitelist) || !Array.isArray(blacklist) || !Array.isArray(risk) || !Array.isArray(target)) {
    throw new Error("AI rules response missing required regex arrays");
  }
  return {
    whitelist_app_regex: normalizeSupervisionPatternList(whitelist),
    blacklist_app_regex: normalizeSupervisionPatternList(blacklist),
    risk_app_regex: normalizeSupervisionPatternList(risk),
    target_app_regex: normalizeSupervisionPatternList(target),
    reason: cleanText(String(parsed.reason || ""), 180),
  };
}

export function parseDecisionResponse(raw: string): SupervisionDecision {
  const parsed = parseAiJsonObject(raw);
  const rawDeviceCommands = parsed["设备命令"];
  if (!Array.isArray(rawDeviceCommands)) {
    throw new Error("AI supervision response missing 设备命令 array");
  }
  const deviceDecisions = rawDeviceCommands
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    .map(parseDeviceDecision)
    .filter((item) => item.device_id);
  return aggregateDeviceDecisions(deviceDecisions);
}

function parseDeviceDecision(parsed: Record<string, unknown>): SupervisionCommandDecision {
  const deviceId = cleanDecisionDeviceId(parsed.device_id);
  const freezeCommands = normalizeSupervisionPatternList(parsed["冻结命令"]);
  const rawUnfreezeCommands = arrayItems(parsed["解冻命令"]);
  const unfreezeAll = rawUnfreezeCommands.some(isAllCommand);
  const unfreezeCommands = normalizeSupervisionPatternList(rawUnfreezeCommands.filter((item) => !isAllCommand(item)));
  const vibrateValue = parsed["是否震动"];
  const screenOffValue = parsed["是否息屏"];
  if (typeof vibrateValue !== "boolean") {
    throw new Error("AI supervision response missing 是否震动 boolean");
  }
  if (typeof screenOffValue !== "boolean") {
    throw new Error("AI supervision response missing 是否息屏 boolean");
  }
  const unfreeze = unfreezeAll || unfreezeCommands.length > 0;
  const reason = cleanText(String(parsed["原因"] || ""), 180) || (unfreeze ? "已回到目标任务" : "");
  const message = cleanText(String(parsed["要说的话"] || ""), 180);
  const explicitDeviated = parsed["是否偏离"];
  const deviated = explicitDeviated === true || freezeCommands.length > 0 || (!unfreeze && vibrateValue === true && !!message);
  return {
    device_id: deviceId,
    deviated,
    message: message || (deviated || unfreeze ? reason : ""),
    reason,
    vibrate: !unfreeze && vibrateValue === true,
    freeze: !unfreeze && freezeCommands.length > 0,
    freeze_commands: freezeCommands,
    screen_off: !unfreeze && screenOffValue === true,
    unfreeze,
    unfreeze_commands: unfreezeAll ? ["全部"] : unfreezeCommands,
  };
}

function aggregateDeviceDecisions(deviceDecisions: SupervisionCommandDecision[]): SupervisionDecision {
  return {
    deviated: deviceDecisions.some((item) => item.deviated),
    message: cleanText(deviceDecisions.map((item) => item.message).filter(Boolean).join(" / "), 180),
    reason: cleanText(deviceDecisions.map((item) => item.reason).filter(Boolean).join(" / "), 180),
    vibrate: deviceDecisions.some((item) => item.vibrate),
    freeze: deviceDecisions.some((item) => item.freeze),
    freeze_commands: uniquePatterns(deviceDecisions.flatMap((item) => item.freeze_commands)),
    screen_off: deviceDecisions.some((item) => item.screen_off),
    unfreeze: deviceDecisions.some((item) => item.unfreeze),
    unfreeze_commands: uniquePatterns(deviceDecisions.flatMap((item) => item.unfreeze_commands)),
    device_decisions: deviceDecisions,
  };
}

function arrayItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => cleanText(item, 120))
    .filter(Boolean);
}

function isAllCommand(value: unknown): boolean {
  return typeof value === "string" && value.replace(/\s+/g, "").trim() === "全部";
}

function uniquePatterns(patterns: string[]): string[] {
  const out: string[] = [];
  for (const pattern of patterns) {
    if (!out.includes(pattern)) out.push(pattern);
    if (out.length >= 12) break;
  }
  return out;
}

function cleanDecisionDeviceId(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
}

function cleanText(value: string | null | undefined, maxLength: number): string {
  if (!value) return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}
