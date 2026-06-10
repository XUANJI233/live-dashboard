const MAX_PATTERN_COUNT = 12;
const MAX_PATTERN_LENGTH = 120;

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
