import type { TimelineSegment } from "../types";
import { promptText } from "./prompt-text";

const MAX_PATTERN_COUNT = 12;
const MAX_PATTERN_LENGTH = 120;

export interface CompiledSupervisionRules {
  whitelist: RegExp[];
  blacklist: RegExp[];
  risk: RegExp[];
  target: RegExp[];
  whitelistPatterns: string[];
  blacklistPatterns: string[];
  riskPatterns: string[];
  targetPatterns: string[];
}

export interface SupervisionRuleMatch {
  whitelisted: boolean;
  blacklisted: boolean;
  risked: boolean;
  targeted: boolean;
}

export function compileSupervisionRules(rules: {
  whitelist_app_regex: unknown;
  blacklist_app_regex: unknown;
  risk_app_regex: unknown;
  target_app_regex: unknown;
}): CompiledSupervisionRules {
  const whitelistPatterns = normalizeSupervisionPatternList(rules.whitelist_app_regex);
  const blacklistPatterns = normalizeSupervisionPatternList(rules.blacklist_app_regex);
  const riskPatterns = normalizeSupervisionPatternList(rules.risk_app_regex);
  const targetPatterns = normalizeSupervisionPatternList(rules.target_app_regex);
  return {
    whitelist: compileRegexList(whitelistPatterns),
    blacklist: compileRegexList(blacklistPatterns),
    risk: compileRegexList(riskPatterns),
    target: compileRegexList(targetPatterns),
    whitelistPatterns,
    blacklistPatterns,
    riskPatterns,
    targetPatterns,
  };
}

// Server-side rules match the combined app name, id, and title of one timeline
// segment; trigger statistics and the controller usage digest share this result.
export function matchSegmentSupervisionRules(
  segment: Pick<TimelineSegment, "app_name" | "app_id" | "display_title">,
  rules: CompiledSupervisionRules,
): SupervisionRuleMatch {
  const text = promptText(`${segment.app_name} ${segment.app_id} ${segment.display_title}`, 240);
  const whitelisted = rules.whitelist.some((rule) => rule.test(text));
  return {
    whitelisted,
    blacklisted: !whitelisted && rules.blacklist.some((rule) => rule.test(text)),
    risked: !whitelisted && rules.risk.some((rule) => rule.test(text)),
    targeted: rules.target.some((rule) => rule.test(text)),
  };
}

function compileRegexList(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const pattern of patterns.slice(0, MAX_PATTERN_COUNT)) {
    if (!isSafeSupervisionPattern(pattern)) continue;
    try {
      out.push(new RegExp(pattern, "i"));
    } catch {
      // Skip invalid AI-generated patterns.
    }
  }
  return out;
}

export function normalizeSupervisionPatternList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const pattern = normalizeRegexPattern(cleanPatternText(item));
    if (!pattern || !isSafeSupervisionPattern(pattern)) continue;
    if (!out.includes(pattern)) out.push(pattern);
    if (out.length >= MAX_PATTERN_COUNT) break;
  }
  return out;
}

export function isSafeSupervisionPattern(pattern: string): boolean {
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH) return false;
  const compact = pattern.replace(/\s+/g, "");
  if (compact === ".*" || compact === ".+" || compact === "[\\s\\S]*" || compact === "[\\S\\s]*") return false;
  if (/\\[1-9]/.test(pattern)) return false;
  if (/\(\?<[!=]/.test(pattern)) return false;
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) return false;
  if (/(?:\.\*){3,}/.test(pattern)) return false;
  if (/\{\d{3,}(?:,|\})/.test(pattern)) return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function normalizeRegexPattern(pattern: string): string {
  const unwrappedPattern = unwrapRegExpConstructorPattern(pattern) ?? pattern;
  const withoutInlineFlag = unwrappedPattern.replace(/^\(\?i\)/i, "").trim();
  const scopedInlineFlag = withoutInlineFlag.match(/^\(\?i:(.*)\)$/i);
  if (scopedInlineFlag) return `(?:${scopedInlineFlag[1]})`;
  return withoutInlineFlag;
}

function unwrapRegExpConstructorPattern(pattern: string): string | null {
  const match = pattern.match(/^(?:new\s+)?RegExp\s*\(([\s\S]*)\)\s*;?$/);
  if (!match) return null;
  const args = match[1]?.trim() || "";
  const firstArg = parseQuotedArgument(args);
  if (!firstArg) return null;
  const rest = args.slice(firstArg.end).trim();
  if (rest && !/^,\s*["'`][a-z]*["'`]\s*$/i.test(rest)) return null;
  return firstArg.value.trim();
}

function parseQuotedArgument(value: string): { value: string; end: number } | null {
  const quote = value[0];
  if (quote !== "\"" && quote !== "'" && quote !== "`") return null;
  let escaped = false;
  let raw = "";
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index]!;
    if (escaped) {
      raw += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === quote) {
      return { value: decodeQuotedArgument(raw, quote), end: index + 1 };
    }
    raw += char;
  }
  return null;
}

function decodeQuotedArgument(raw: string, quote: string): string {
  if (quote === "\"") {
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      // Fall through to conservative unescaping.
    }
  }
  return raw
    .replace(/\\\\/g, "\\")
    .replace(/\\(["'`])/g, "$1")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");
}

function cleanPatternText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PATTERN_LENGTH);
}
