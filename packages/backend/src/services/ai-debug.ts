const MAX_DEBUG_STRING_LENGTH = 20_000;
const MAX_DEBUG_PAYLOAD_LENGTH = 120_000;
const SENSITIVE_KEY_PATTERN = /(?:api[_-]?key|authorization|bearer|secret|token|password|ciphertext|signature|private[_-]?key)/i;
const KEY_LIKE_STRING_PATTERN = /\b(?:sk|ak|rk)-[A-Za-z0-9_-]{8,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi;

export function isAiDebugLogEnabled(): boolean {
  return envFlagIsTrue(process.env.AI_DEBUG_LOG) || envFlagIsTrue(process.env.AI_DEBUG);
}

export function logAiDebug(label: string, payload: unknown): void {
  if (!isAiDebugLogEnabled()) return;
  try {
    const text = JSON.stringify(redactAiDebugValue(payload), null, 2);
    console.log(`[ai-debug:${label}] ${text.slice(0, MAX_DEBUG_PAYLOAD_LENGTH)}`);
  } catch (e) {
    const reason = e instanceof Error ? e.message : "unknown";
    console.log(`[ai-debug:${label}] <unserializable: ${reason}>`);
  }
}

function redactAiDebugValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > 8) return "[MaxDepth]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (SENSITIVE_KEY_PATTERN.test(key)) return "[REDACTED]";
    return redactAiDebugString(value).slice(0, MAX_DEBUG_STRING_LENGTH);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 120).map((item) => redactAiDebugValue(item, key, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      out[entryKey] = SENSITIVE_KEY_PATTERN.test(entryKey)
        ? "[REDACTED]"
        : redactAiDebugValue(entryValue, entryKey, depth + 1);
    }
    return out;
  }
  return String(value);
}

function redactAiDebugString(value: string): string {
  return value
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(KEY_LIKE_STRING_PATTERN, "[REDACTED_KEY]");
}

function envFlagIsTrue(value: string | undefined): boolean {
  return String(value || "").trim().toLowerCase() === "true";
}
