import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// One result envelope for every Live MCP tool: structuredContent plus an equivalent compact
// text view, `isError` on failures, and stable lowercase error codes.

export function toolResult(value: Record<string, unknown>, text?: string): CallToolResult {
  return {
    structuredContent: value,
    // The text view repeats structuredContent, so it stays compact.
    content: [{ type: "text", text: text ?? JSON.stringify(value) }],
    // Failures are flagged so MCP clients surface them instead of reading them as results.
    ...(value.ok === false ? { isError: true } : {}),
  };
}

export async function stableToolResult(
  build: () => unknown | Promise<unknown>,
  textView?: (value: Record<string, unknown>) => string,
): Promise<CallToolResult> {
  try {
    const value = objectResult(await build());
    return toolResult(value, textView?.(value));
  } catch (error) {
    const code = errorCode(error);
    if (code === "internal_error") {
      console.error("[mcp] tool failed:", error);
    }
    return toolResult({ ok: false, error: code });
  }
}

function objectResult(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

function stableErrorCode(value: string): boolean {
  return /^[a-z][a-z0-9_]{2,80}$/.test(value);
}

// A message that is already a code wins; otherwise a typed error's code (AiJobInputError and
// friends use UPPER_SNAKE) is kept instead of collapsing every sentence to internal_error.
function errorCode(error: unknown): string {
  if (error instanceof Error && stableErrorCode(error.message)) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{2,80}$/.test(code)) return code.toLowerCase();
  return "internal_error";
}
