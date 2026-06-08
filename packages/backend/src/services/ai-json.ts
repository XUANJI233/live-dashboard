export function parseAiJsonObject(raw: string): Record<string, unknown> {
  const text = stripJsonFence(String(raw || "").trim());
  const direct = parseObjectCandidate(text);
  if (direct) return direct;

  for (const candidate of balancedObjectCandidates(text)) {
    const parsed = parseObjectCandidate(candidate);
    if (parsed) return parsed;
  }

  throw new Error("AI response did not contain a JSON object");
}

function stripJsonFence(value: string): string {
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() || value;
}

function parseObjectCandidate(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string") return parseObjectCandidate(parsed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function* balancedObjectCandidates(value: string): Generator<string> {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== "}" || depth === 0) continue;

    depth -= 1;
    if (depth === 0 && start >= 0) {
      yield value.slice(start, index + 1);
      start = -1;
    }
  }
}
