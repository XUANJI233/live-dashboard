import { HASH_SECRET, metaGet, metaSet } from "../db";
import { x25519 } from "@noble/curves/ed25519.js";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGateway, generateText, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import { deepSeekCachePrimingMiddleware } from "./ai-cache-middleware";
import { logAiDebug } from "./ai-debug";

const ENV_AI_API_URL = process.env.AI_API_URL || "";
const ENV_AI_API_KEY = process.env.AI_API_KEY || "";
const ENV_AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini";
const AI_RUNTIME_CONFIG_KEY = "ai_runtime_config";
const AI_CURVE_KEYPAIR_KEY = "ai_curve25519_keypair";
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const MAX_CLOCK_SKEW_SECONDS = 300;
const AI_CONFIG_ENCRYPTION_ALG = "X25519-A256GCM-HS256";
const AI_CONFIG_PAYLOAD_VERSION = 2;
const SEALED_JSON_VERSION = 2;
const STORE_SEALING_SALT = "live-dashboard-ai-config-store-v2";
const AI_CONFIG_TEST_MAX_TOKENS = 8192;
const AI_CHAT_TIMEOUT_MS = 5 * 60_000;
const AI_CHAT_MIN_TIMEOUT_MS = 1_000;
const AI_CHAT_MAX_RETRIES = 3;

export interface AiRuntimeConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  source: "env" | "server";
}

export interface AiConfigTestResult {
  ok: boolean;
  message: string;
  models: string[];
  selected_model: string;
  model_available: boolean | null;
  models_url: string;
  chat_checked: boolean;
  models_error?: string;
}

export interface AiConfigDescription {
  configured: boolean;
  locked: boolean;
  source: "env" | "server" | "none";
  api_url?: string;
  api_url_hint?: string;
  model: string;
  updated_at: string | null;
  message?: string;
  encryption?: {
    alg: typeof AI_CONFIG_ENCRYPTION_ALG;
    public_key: string;
    public_key_sha256: string;
  };
}

interface StoredAiConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  updatedAt: string;
}

interface CurveKeypair {
  privateKey: string;
  publicKey: string;
  createdAt: string;
}

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function isAiEnvConfigured(): boolean {
  return !!(ENV_AI_API_URL && ENV_AI_API_KEY);
}

export async function describeAiConfig(): Promise<AiConfigDescription> {
  const encryption = isAiEnvConfigured() ? undefined : await getAiConfigEncryptionInfo();
  if (isAiEnvConfigured()) {
    return {
      configured: true,
      locked: true,
      source: "env",
      api_url_hint: maskUrl(ENV_AI_API_URL),
      model: ENV_AI_MODEL,
      updated_at: null,
      message: "AI 配置由服务器环境变量提供，App 不能覆盖。",
    };
  }

  const stored = await readStoredAiConfig();
  if (!stored) {
    return {
      configured: false,
      locked: false,
      source: "none",
      model: ENV_AI_MODEL,
      updated_at: null,
      encryption,
    };
  }

  return {
    configured: true,
    locked: false,
    source: "server",
    api_url: stored.apiUrl,
    api_url_hint: maskUrl(stored.apiUrl),
    model: stored.model,
    updated_at: stored.updatedAt,
    encryption,
  };
}

export async function getAiRuntimeConfig(): Promise<AiRuntimeConfig | null> {
  if (isAiEnvConfigured()) {
    return {
      apiUrl: ENV_AI_API_URL,
      apiKey: ENV_AI_API_KEY,
      model: ENV_AI_MODEL,
      source: "env",
    };
  }

  const stored = await readStoredAiConfig();
  if (!stored) return null;
  return {
    apiUrl: stored.apiUrl,
    apiKey: stored.apiKey,
    model: stored.model,
    source: "server",
  };
}

export async function saveEncryptedAiConfigFromDevice(input: unknown, deviceToken: string): Promise<AiConfigDescription> {
  if (isAiEnvConfigured()) {
    throw Object.assign(new Error("AI 配置由服务器环境变量提供，App 不能覆盖。"), { code: "AI_CONFIG_LOCKED", status: 409 });
  }
  if (!deviceToken) {
    throw Object.assign(new Error("Missing device token"), { code: "TOKEN_REQUIRED", status: 401 });
  }
  const config = await configWithReusableStoredKey(await decryptDevicePayload(input, deviceToken));
  await writeStoredAiConfig(config);
  return describeAiConfig();
}

export async function testEncryptedAiConfigFromDevice(input: unknown, deviceToken: string): Promise<AiConfigTestResult> {
  if (isAiEnvConfigured()) {
    throw Object.assign(new Error("AI 配置由服务器环境变量提供，App 不能覆盖。"), { code: "AI_CONFIG_LOCKED", status: 409 });
  }
  if (!deviceToken) {
    throw Object.assign(new Error("Missing device token"), { code: "TOKEN_REQUIRED", status: 401 });
  }
  const config = await configWithReusableStoredKey(await decryptDevicePayload(input, deviceToken));
  return testAiConfigConnection(config);
}

export async function testAiConfigConnection(config: Pick<AiRuntimeConfig, "apiUrl" | "apiKey" | "model">): Promise<AiConfigTestResult> {
  const normalized: AiRuntimeConfig = {
    apiUrl: normalizeAiApiUrl(config.apiUrl),
    apiKey: config.apiKey,
    model: String(config.model || ENV_AI_MODEL || "gpt-4o-mini").trim(),
    source: "server",
  };
  const modelsUrl = modelsUrlFromAiApiUrl(normalized.apiUrl);
  let models: string[] = [];
  let modelsError: string | undefined;
  try {
    models = await fetchAiModels(normalized, modelsUrl);
  } catch (e) {
    modelsError = safeErrorMessage(e);
  }

  const requestedModel = normalized.model;
  const chatModel = modelForConnectionTest(requestedModel, models, normalized.apiUrl);
  const modelAvailable = models.length > 0 ? models.includes(chatModel) : null;
  const modelAdjusted = chatModel !== requestedModel;
  try {
    await requestAiChatCompletion({ ...normalized, model: chatModel }, {
      messages: [
        { role: "system", content: "你是连接测试助手。只返回 OK。" },
        { role: "user", content: "ping" },
      ],
      maxTokens: AI_CONFIG_TEST_MAX_TOKENS,
      temperature: 0,
      timeoutMs: 20_000,
    });
  } catch (e) {
    const detail = safeErrorMessage(e);
    return {
      ok: false,
      message: models.length > 0
        ? `模型列表获取成功，但聊天端点测试失败：${detail}`
        : `AI 连接测试失败：${detail}`,
      models,
      selected_model: chatModel,
      model_available: modelAvailable,
      models_url: modelsUrl,
      chat_checked: true,
      ...(modelsError ? { models_error: modelsError } : {}),
    };
  }

  const availabilityText = modelAvailable === false
    ? `，但模型列表里没有 ${normalized.model}`
    : "";
  const modelText = models.length > 0
    ? `已获取 ${models.length} 个模型`
    : `聊天测试通过，模型列表不可用：${modelsError || "供应商未返回模型列表"}`;
  const adjustedText = modelAdjusted
    ? `，已自动使用可用模型 ${chatModel} 完成聊天测试`
    : "";
  return {
    ok: true,
    message: `${modelText}${availabilityText}${adjustedText}`,
    models,
    selected_model: chatModel,
    model_available: modelAvailable,
    models_url: modelsUrl,
    chat_checked: true,
    ...(modelsError ? { models_error: modelsError } : {}),
  };
}

export async function requestAiChatCompletion(
  config: Pick<AiRuntimeConfig, "apiUrl" | "apiKey" | "model">,
  options: {
    messages: AiChatMessage[];
    maxTokens: number;
    temperature?: number;
    timeoutMs?: number;
    middleware?: LanguageModelMiddleware | LanguageModelMiddleware[];
  },
): Promise<string> {
  const timeoutMs = normalizeAiChatTimeoutMs(options.timeoutMs);
  const system = options.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n") || undefined;
  const messages = options.messages.filter((message) => message.role !== "system");
  const providerOptions = aiProviderOptions(config);
  let lastError: unknown;

  for (let attempt = 0; attempt <= AI_CHAT_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await generateText({
        model: languageModelForConfig(config, options.middleware),
        ...(system ? { system } : {}),
        messages,
        maxOutputTokens: options.maxTokens,
        temperature: options.temperature,
        ...(providerOptions ? { providerOptions } : {}),
        abortSignal: controller.signal,
        maxRetries: 0,
      });
      logAiCacheUsage(config.model, result.usage, result.providerMetadata);
      const text = result.text.trim();
      if (!text) {
        throw Object.assign(new Error("Empty AI response"), { code: "AI_CHAT_EMPTY" });
      }
      return text;
    } catch (e) {
      lastError = (e as Error).name === "AbortError"
        ? Object.assign(new Error("AI API request timed out"), { code: "AI_CHAT_TIMEOUT" })
        : e;
      if (attempt >= AI_CHAT_MAX_RETRIES) break;
      logAiDebug("chat.retry", {
        model: config.model,
        attempt: attempt + 1,
        retriesRemaining: AI_CHAT_MAX_RETRIES - attempt,
        error: safeErrorMessage(lastError),
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  const code = (lastError as { code?: string } | null)?.code;
  if (code === "AI_CHAT_TIMEOUT") {
    throw Object.assign(new Error("AI API request timed out"), { code });
  }
  throw Object.assign(new Error(redactAiError(safeErrorMessage(lastError), config.apiKey)), {
    code: code === "AI_CHAT_EMPTY" ? "AI_CHAT_EMPTY" : "AI_CHAT_FAILED",
  });
}

export async function requestAiChatCompletionWithCachePriming(
  config: Pick<AiRuntimeConfig, "apiUrl" | "apiKey" | "model">,
  options: {
    messages: AiChatMessage[];
    finalUserMessage: string;
    maxTokens: number;
    temperature?: number;
    timeoutMs?: number;
    warmupMaxTokens?: number;
  },
): Promise<string> {
  const finalUserMessage: AiChatMessage = { role: "user", content: options.finalUserMessage };
  return requestAiChatCompletion(config, {
    messages: [...options.messages, finalUserMessage],
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    timeoutMs: options.timeoutMs,
    ...(isDeepSeekRequest(config)
      ? {
        middleware: deepSeekCachePrimingMiddleware({
          model: config.model,
          warmupMaxTokens: options.warmupMaxTokens,
        }),
      }
      : {}),
  });
}

function modelForConnectionTest(requestedModel: string, models: string[], apiUrl: string): string {
  const requested = requestedModel.trim();
  if (models.length === 0) {
    if (isDeepSeekEndpoint(apiUrl) && isOpenAiDefaultModel(requested)) return "deepseek-chat";
    return requested;
  }
  if (models.includes(requested)) return requested;
  if (isDeepSeekEndpoint(apiUrl)) {
    const preferredDeepSeek = ["deepseek-chat", "deepseek-reasoner"].find((model) => models.includes(model));
    if (preferredDeepSeek) return preferredDeepSeek;
  }
  return models[0] || requested;
}

function isOpenAiDefaultModel(model: string): boolean {
  return !model || model === "gpt-4o-mini" || model.startsWith("gpt-");
}

function languageModelForConfig(
  config: Pick<AiRuntimeConfig, "apiUrl" | "apiKey" | "model">,
  middleware?: LanguageModelMiddleware | LanguageModelMiddleware[],
) {
  const baseURL = baseUrlFromAiApiUrl(config.apiUrl);
  let model: LanguageModel;
  if (isAiGatewayEndpoint(config.apiUrl)) {
    const provider = createGateway({
      apiKey: config.apiKey,
      baseURL,
    });
    model = provider.chat(config.model as never);
  } else if (isDeepSeekEndpoint(config.apiUrl)) {
    const provider = createDeepSeek({
      apiKey: config.apiKey,
      baseURL,
    });
    model = provider.chat(config.model as never);
  } else {
    const provider = createOpenAICompatible({
      name: "configured-openai-compatible",
      apiKey: config.apiKey,
      baseURL,
    });
    model = provider.chatModel(config.model);
  }
  return middleware ? wrapLanguageModel({ model, middleware }) : model;
}

function isDeepSeekEndpoint(apiUrl: string): boolean {
  try {
    const host = new URL(apiUrl).hostname.toLowerCase();
    return host === "api.deepseek.com" || host.endsWith(".deepseek.com");
  } catch {
    return false;
  }
}

function isAiGatewayEndpoint(apiUrl: string): boolean {
  try {
    const host = new URL(apiUrl).hostname.toLowerCase();
    return host === "ai-gateway.vercel.sh";
  } catch {
    return false;
  }
}

function providerSlugFromGatewayModel(model: string): string {
  const [slug] = model.split("/", 1);
  return slug?.trim().toLowerCase() || "";
}

function isDeepSeekRequest(config: Pick<AiRuntimeConfig, "apiUrl" | "model">): boolean {
  return isDeepSeekEndpoint(config.apiUrl) ||
    (isAiGatewayEndpoint(config.apiUrl) && providerSlugFromGatewayModel(config.model) === "deepseek");
}

function aiProviderOptions(config: Pick<AiRuntimeConfig, "apiUrl" | "model">) {
  if (!isDeepSeekRequest(config)) return undefined;
  return {
    deepseek: {
      thinking: { type: "enabled" },
    },
  };
}

function normalizeAiChatTimeoutMs(value: unknown): number {
  if (value === undefined || value === null) return AI_CHAT_TIMEOUT_MS;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return AI_CHAT_TIMEOUT_MS;
  return Math.min(AI_CHAT_TIMEOUT_MS, Math.max(AI_CHAT_MIN_TIMEOUT_MS, Math.trunc(parsed)));
}

function logAiCacheUsage(model: string, usage: unknown, providerMetadata: unknown): void {
  const source = usage && typeof usage === "object" ? usage as Record<string, unknown> : {};
  const details = source.inputTokenDetails && typeof source.inputTokenDetails === "object"
    ? source.inputTokenDetails as Record<string, unknown>
    : {};
  const raw = source.raw && typeof source.raw === "object" ? source.raw as Record<string, unknown> : {};
  const metadata = providerMetadata && typeof providerMetadata === "object"
    ? providerMetadata as Record<string, unknown>
    : {};
  const deepseek = metadata.deepseek && typeof metadata.deepseek === "object"
    ? metadata.deepseek as Record<string, unknown>
    : {};
  const cacheReadTokens =
    numberValue(details.cacheReadTokens) ??
    numberValue(source.cachedInputTokens) ??
    numberValue(deepseek.promptCacheHitTokens) ??
    numberValue(raw.prompt_cache_hit_tokens) ??
    nestedNumber(raw, ["prompt_tokens_details", "cached_tokens"]);
  const cacheWriteTokens = numberValue(details.cacheWriteTokens);
  const cacheMissTokens =
    numberValue(details.noCacheTokens) ??
    numberValue(deepseek.promptCacheMissTokens) ??
    numberValue(raw.prompt_cache_miss_tokens);
  const inputTokens =
    numberValue(source.inputTokens) ??
    sumTokenCounts(cacheReadTokens, cacheMissTokens) ??
    numberValue(raw.prompt_tokens);
  if (cacheReadTokens == null && cacheWriteTokens == null && cacheMissTokens == null) return;
  const cacheHitRate = inputTokens && cacheReadTokens != null
    ? `${Math.round((cacheReadTokens / inputTokens) * 1000) / 10}%`
    : undefined;
  const parts = [
    `model=${model}`,
    inputTokens != null ? `input_tokens=${inputTokens}` : "",
    cacheReadTokens != null ? `cache_read=${cacheReadTokens}` : "",
    cacheWriteTokens != null ? `cache_write=${cacheWriteTokens}` : "",
    cacheMissTokens != null ? `cache_miss=${cacheMissTokens}` : "",
    cacheHitRate ? `cache_hit_rate=${cacheHitRate}` : "",
  ].filter(Boolean);
  console.log(`[ai-cache] ${parts.join(" ")}`);
}

function sumTokenCounts(left: number | undefined, right: number | undefined): number | undefined {
  if (left == null && right == null) return undefined;
  return (left ?? 0) + (right ?? 0);
}

function nestedNumber(source: Record<string, unknown>, path: string[]): number | undefined {
  let current: unknown = source;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return numberValue(current);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function decryptDevicePayload(input: unknown, deviceToken: string): Promise<StoredAiConfig> {
  const body = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const v = Number(body.v);
  const alg = String(body.alg || "");
  const ts = Number(body.ts);
  const serverPublicKey = typeof body.server_public_key === "string" ? body.server_public_key : "";
  const ephemeralPublicKey = typeof body.ephemeral_public_key === "string" ? body.ephemeral_public_key : "";
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  const ciphertext = typeof body.ciphertext === "string" ? body.ciphertext : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  if (
    v !== AI_CONFIG_PAYLOAD_VERSION ||
    alg !== AI_CONFIG_ENCRYPTION_ALG ||
    !Number.isFinite(ts) ||
    !serverPublicKey ||
    !ephemeralPublicKey ||
    !nonce ||
    !ciphertext ||
    !signature
  ) {
    throw Object.assign(new Error("Invalid encrypted AI config payload"), { code: "AI_CONFIG_PAYLOAD_INVALID", status: 400 });
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > MAX_CLOCK_SKEW_SECONDS) {
    throw Object.assign(new Error("Encrypted AI config payload expired"), { code: "AI_CONFIG_PAYLOAD_EXPIRED", status: 400 });
  }

  const signedMetadata = signedMetadataForPayload(v, ts, serverPublicKey, ephemeralPublicKey, nonce);
  const signed = `${signedMetadata}.${ciphertext}`;
  const expected = await hmacBase64Url(deviceToken, signed);
  if (!constantTimeEqual(signature, expected)) {
    throw Object.assign(new Error("Invalid AI config signature"), { code: "AI_CONFIG_SIGNATURE_INVALID", status: 403 });
  }

  let plaintext = "";
  const keypair = await getServerCurveKeypair();
  if (serverPublicKey !== keypair.publicKey) {
    throw Object.assign(new Error("AI config server key mismatch"), { code: "AI_CONFIG_SERVER_KEY_MISMATCH", status: 409 });
  }
  try {
    const nonceBytes = base64UrlDecode(nonce);
    const shared = x25519.getSharedSecret(
      base64UrlDecode(keypair.privateKey),
      base64UrlDecode(ephemeralPublicKey),
    );
    const key = await aesKeyFromShared(
      shared,
      nonceBytes,
      ["decrypt"],
      kdfInfoForPayload(v, keypair.publicKey, ephemeralPublicKey),
    );
    const algorithm = {
      name: "AES-GCM",
      iv: bufferSource(nonceBytes),
      additionalData: bufferSource(TEXT_ENCODER.encode(signedMetadata)),
    };
    const decrypted = await crypto.subtle.decrypt(
      algorithm,
      key,
      bufferSource(base64UrlDecode(ciphertext)),
    );
    plaintext = TEXT_DECODER.decode(decrypted);
  } catch {
    throw Object.assign(new Error("AI config decrypt failed"), { code: "AI_CONFIG_DECRYPT_FAILED", status: 400 });
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw Object.assign(new Error("AI config JSON invalid"), { code: "AI_CONFIG_JSON_INVALID", status: 400 });
  }

  return validateStoredConfig(parsed);
}

function validateStoredConfig(input: Record<string, unknown>): StoredAiConfig {
  const apiUrl = normalizeAiApiUrl(String(input.api_url || input.apiUrl || ""));
  const apiKey = String(input.api_key || input.apiKey || "").trim();
  const model = String(input.model || ENV_AI_MODEL || "gpt-4o-mini").trim();
  if (apiKey.length > 0 && (apiKey.length < 8 || apiKey.length > 4096)) {
    throw Object.assign(new Error("AI API key invalid"), { code: "AI_KEY_INVALID", status: 400 });
  }
  if (!/^[\w.:\-\/]{1,120}$/.test(model)) {
    throw Object.assign(new Error("AI model invalid"), { code: "AI_MODEL_INVALID", status: 400 });
  }
  return {
    apiUrl,
    apiKey,
    model,
    updatedAt: new Date().toISOString(),
  };
}

async function configWithReusableStoredKey(config: StoredAiConfig): Promise<StoredAiConfig> {
  if (config.apiKey) return config;
  const stored = await readStoredAiConfig();
  if (!stored?.apiKey) {
    throw Object.assign(new Error("AI API key required for the first configuration"), { code: "AI_KEY_REQUIRED", status: 400 });
  }
  return {
    ...config,
    apiKey: stored.apiKey,
  };
}

export function modelsUrlFromAiApiUrl(apiUrl: string): string {
  const url = new URL(baseUrlFromAiApiUrl(apiUrl));
  const trimmedPath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${trimmedPath}/models`.replace(/\/{2,}/g, "/") || "/models";
  url.search = "";
  url.hash = "";
  return url.href;
}

export function baseUrlFromAiApiUrl(apiUrl: string): string {
  const url = new URL(normalizeAiApiUrl(apiUrl));
  const trimmedPath = url.pathname.replace(/\/+$/, "");
  const lower = trimmedPath.toLowerCase();
  const replacements = [
    "/chat/completions",
    "/responses",
    "/completions",
    "/models",
  ];
  let nextPath = trimmedPath || "";
  for (const suffix of replacements) {
    if (lower.endsWith(suffix)) {
      nextPath = trimmedPath.slice(0, trimmedPath.length - suffix.length) || "/";
      break;
    }
  }
  url.pathname = nextPath || "/";
  url.search = "";
  url.hash = "";
  return url.href;
}

async function fetchAiModels(config: Pick<AiRuntimeConfig, "apiKey">, modelsUrl: string): Promise<string[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(modelsUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw Object.assign(new Error(`Models API returned ${res.status}: ${redactAiError(text, config.apiKey)}`), {
        status: res.status,
        code: "AI_MODELS_FAILED",
      });
    }
    const data = await res.json() as { data?: Array<{ id?: unknown }> };
    const models = (Array.isArray(data.data) ? data.data : [])
      .map((item) => typeof item?.id === "string" ? item.id.trim() : "")
      .filter(Boolean);
    if (models.length === 0) {
      throw Object.assign(new Error("Models API returned no model ids"), { code: "AI_MODELS_EMPTY" });
    }
    return Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw Object.assign(new Error("Models API request timed out"), { code: "AI_MODELS_TIMEOUT" });
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readStoredAiConfig(): Promise<StoredAiConfig | null> {
  try {
    const parsed = await readSealedJson<StoredAiConfig>(AI_RUNTIME_CONFIG_KEY);
    if (!parsed) return null;
    const apiUrl = normalizeAiApiUrl(parsed.apiUrl);
    return {
      apiUrl,
      apiKey: parsed.apiKey,
      model: parsed.model || ENV_AI_MODEL,
      updatedAt: parsed.updatedAt || "",
    };
  } catch {
    return null;
  }
}

async function writeStoredAiConfig(config: StoredAiConfig): Promise<void> {
  await writeSealedJson(AI_RUNTIME_CONFIG_KEY, config);
}

async function getAiConfigEncryptionInfo(): Promise<{ alg: typeof AI_CONFIG_ENCRYPTION_ALG; public_key: string; public_key_sha256: string }> {
  const keypair = await getServerCurveKeypair();
  return {
    alg: AI_CONFIG_ENCRYPTION_ALG,
    public_key: keypair.publicKey,
    public_key_sha256: await sha256Base64Url(base64UrlDecode(keypair.publicKey)),
  };
}

async function getServerCurveKeypair(): Promise<CurveKeypair> {
  const existing = await readSealedJson<CurveKeypair>(AI_CURVE_KEYPAIR_KEY);
  if (existing?.privateKey && existing.publicKey) return existing;

  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const keypair: CurveKeypair = {
    privateKey: base64UrlEncode(privateKey),
    publicKey: base64UrlEncode(publicKey),
    createdAt: new Date().toISOString(),
  };
  await writeSealedJson(AI_CURVE_KEYPAIR_KEY, keypair);
  return keypair;
}

async function readSealedJson<T>(key: string): Promise<T | null> {
  const raw = metaGet(key);
  if (!raw) return null;
  const sealed = JSON.parse(raw) as { v?: number; nonce?: string; ciphertext?: string; kid?: string };
  if (
    sealed.v !== SEALED_JSON_VERSION ||
    sealed.kid !== `${STORE_SEALING_SALT}:${key}` ||
    !sealed.nonce ||
    !sealed.ciphertext
  ) {
    return null;
  }
  const aes = await sealedJsonKey(key, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bufferSource(base64UrlDecode(sealed.nonce)) },
    aes,
    bufferSource(base64UrlDecode(sealed.ciphertext)),
  );
  return JSON.parse(TEXT_DECODER.decode(decrypted)) as T;
}

async function writeSealedJson(key: string, value: unknown): Promise<void> {
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const aes = await sealedJsonKey(key, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bufferSource(nonce) },
    aes,
    bufferSource(TEXT_ENCODER.encode(JSON.stringify(value))),
  );
  metaSet(key, JSON.stringify({
    v: SEALED_JSON_VERSION,
    kid: `${STORE_SEALING_SALT}:${key}`,
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
  }));
}

async function sealedJsonKey(metaKey: string, usages: string[]): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey("raw", bufferSource(hexToBytes(HASH_SECRET)), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: bufferSource(TEXT_ENCODER.encode(STORE_SEALING_SALT)),
      info: TEXT_ENCODER.encode(metaKey),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    usages as never,
  );
}

async function aesKeyFromShared(
  shared: Uint8Array,
  salt: Uint8Array,
  usages: string[],
  info: Uint8Array,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey("raw", bufferSource(shared), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: bufferSource(salt),
      info: bufferSource(info),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    usages as never,
  );
}

async function hmacBase64Url(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    bufferSource(TEXT_ENCODER.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, bufferSource(TEXT_ENCODER.encode(data)));
  return base64UrlEncode(new Uint8Array(signature));
}

function signedMetadataForPayload(
  v: number,
  ts: number,
  serverPublicKey: string,
  ephemeralPublicKey: string,
  nonce: string,
): string {
  return `${v}.${ts}.${serverPublicKey}.${ephemeralPublicKey}.${nonce}`;
}

function kdfInfoForPayload(v: number, serverPublicKey: string, ephemeralPublicKey: string): Uint8Array {
  return TEXT_ENCODER.encode(`live-dashboard-ai-config-x25519-v${v}.${serverPublicKey}.${ephemeralPublicKey}`);
}

function normalizeAiApiUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || !url.hostname) {
      throw Object.assign(new Error("AI API URL must be HTTPS"), { code: "AI_URL_INVALID", status: 400 });
    }
    if (url.username || url.password || url.search || url.hash) {
      throw Object.assign(new Error("AI API URL must not contain credentials, query, or fragment"), { code: "AI_URL_UNSAFE", status: 400 });
    }
    return url.href;
  } catch (e) {
    if (e && typeof e === "object" && "code" in e) throw e;
    throw Object.assign(new Error("AI API URL must be HTTPS"), { code: "AI_URL_INVALID", status: 400 });
  }
}

function maskUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return value ? "已配置" : "";
  }
}

function safeErrorMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value || "");
  return message.replace(/\s+/g, " ").trim().slice(0, 300) || "request failed";
}

function redactAiError(value: string, apiKey: string): string {
  let text = value.replace(/\s+/g, " ").trim().slice(0, 500);
  if (apiKey) text = text.replaceAll(apiKey, "[redacted]");
  return text || "request failed";
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlDecode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function hexToBytes(value: string): Uint8Array {
  return new Uint8Array(value.match(/.{1,2}/g)!.map((byte) => Number.parseInt(byte, 16)));
}

async function sha256Base64Url(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bufferSource(value));
  return base64UrlEncode(new Uint8Array(digest));
}

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = TEXT_ENCODER.encode(a);
  const right = TEXT_ENCODER.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i]! ^ right[i]!;
  }
  return diff === 0;
}
