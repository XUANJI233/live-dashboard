import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

export type PromptOverrideKey =
  | "daily_summary_system"
  | "weekly_summary_system"
  | "supervision_rules_system"
  | "supervision_verify_system";

const DEFAULT_PROMPT_FILE = "ai-prompts.json";
const MAX_PROMPT_LENGTH = 16_000;
const EMPTY_PROMPTS: Record<PromptOverrideKey, string> = {
  daily_summary_system: "",
  weekly_summary_system: "",
  supervision_rules_system: "",
  supervision_verify_system: "",
};

interface PromptCache {
  path: string;
  mtimeMs: number;
  values: Partial<Record<PromptOverrideKey, string>>;
}

let promptCache: PromptCache | null = null;

export function promptOverride(key: PromptOverrideKey): string | null {
  const value = loadPromptOverrides()[key];
  return value && value.trim() ? value : null;
}

function loadPromptOverrides(): Partial<Record<PromptOverrideKey, string>> {
  const path = promptOverridePath();
  ensurePromptOverrideFile(path);
  if (!existsSync(path)) {
    promptCache = null;
    return {};
  }

  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return {};
  }
  if (promptCache?.path === path && promptCache.mtimeMs === mtimeMs) {
    return promptCache.values;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const values = normalizePromptOverrides(parsed);
    promptCache = { path, mtimeMs, values };
    return values;
  } catch (error) {
    console.warn("[ai-prompts] Failed to read prompt override file:", safeErrorMessage(error));
    return {};
  }
}

function normalizePromptOverrides(input: unknown): Partial<Record<PromptOverrideKey, string>> {
  const source = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  return {
    daily_summary_system: promptText(source.daily_summary_system),
    weekly_summary_system: promptText(source.weekly_summary_system),
    supervision_rules_system: promptText(source.supervision_rules_system),
    supervision_verify_system: promptText(source.supervision_verify_system),
  };
}

function promptOverridePath(): string {
  const configured = (process.env.AI_PROMPTS_FILE || "").trim();
  if (configured) return resolve(configured);
  const dbPath = process.env.DB_PATH?.trim();
  return resolve(dbPath ? dirname(dbPath) : ".", DEFAULT_PROMPT_FILE);
}

function ensurePromptOverrideFile(path: string): void {
  if (existsSync(path)) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(EMPTY_PROMPTS, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if (!existsSync(path)) {
      console.warn("[ai-prompts] Failed to create prompt override file:", safeErrorMessage(error));
    }
  }
}

function promptText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, MAX_PROMPT_LENGTH);
}

function safeErrorMessage(value: unknown): string {
  return (value instanceof Error ? value.message : String(value || ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300) || "unknown error";
}
