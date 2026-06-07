import { HASH_SECRET, metaGet, metaSet } from "../db";
import { x25519 } from "@noble/curves/ed25519.js";

const ENV_AI_API_URL = process.env.AI_API_URL || "";
const ENV_AI_API_KEY = process.env.AI_API_KEY || "";
const ENV_AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini";
const AI_RUNTIME_CONFIG_KEY = "ai_runtime_config";
const AI_CURVE_KEYPAIR_KEY = "ai_curve25519_keypair";
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const MAX_CLOCK_SKEW_SECONDS = 300;
const AI_CONFIG_ENCRYPTION_ALG = "X25519-A256GCM-HS256";

export interface AiRuntimeConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  source: "env" | "server";
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
  const config = await decryptDevicePayload(input, deviceToken);
  await writeStoredAiConfig(config);
  return describeAiConfig();
}

async function decryptDevicePayload(input: unknown, deviceToken: string): Promise<StoredAiConfig> {
  const body = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const v = Number(body.v);
  const alg = String(body.alg || "");
  const ts = Number(body.ts);
  const ephemeralPublicKey = typeof body.ephemeral_public_key === "string" ? body.ephemeral_public_key : "";
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  const ciphertext = typeof body.ciphertext === "string" ? body.ciphertext : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  if (
    v !== 1 ||
    alg !== AI_CONFIG_ENCRYPTION_ALG ||
    !Number.isFinite(ts) ||
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

  const signed = `${v}.${ts}.${ephemeralPublicKey}.${nonce}.${ciphertext}`;
  const expected = await hmacBase64Url(deviceToken, signed);
  if (!constantTimeEqual(signature, expected)) {
    throw Object.assign(new Error("Invalid AI config signature"), { code: "AI_CONFIG_SIGNATURE_INVALID", status: 403 });
  }

  let plaintext = "";
  try {
    const keypair = await getServerCurveKeypair();
    const shared = x25519.getSharedSecret(
      base64UrlDecode(keypair.privateKey),
      base64UrlDecode(ephemeralPublicKey),
    );
    const key = await aesKeyFromShared(shared, base64UrlDecode(nonce), ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bufferSource(base64UrlDecode(nonce)) },
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
  const apiUrl = String(input.api_url || input.apiUrl || "").trim();
  const apiKey = String(input.api_key || input.apiKey || "").trim();
  const model = String(input.model || ENV_AI_MODEL || "gpt-4o-mini").trim();
  if (!isHttpsUrl(apiUrl)) {
    throw Object.assign(new Error("AI API URL must be HTTPS"), { code: "AI_URL_INVALID", status: 400 });
  }
  if (apiKey.length < 8 || apiKey.length > 4096) {
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

async function readStoredAiConfig(): Promise<StoredAiConfig | null> {
  try {
    const parsed = await readSealedJson<StoredAiConfig>(AI_RUNTIME_CONFIG_KEY);
    if (!parsed) return null;
    return {
      apiUrl: parsed.apiUrl,
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

async function getAiConfigEncryptionInfo(): Promise<{ alg: typeof AI_CONFIG_ENCRYPTION_ALG; public_key: string }> {
  const keypair = await getServerCurveKeypair();
  return { alg: AI_CONFIG_ENCRYPTION_ALG, public_key: keypair.publicKey };
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
  const sealed = JSON.parse(raw) as { v?: number; nonce?: string; ciphertext?: string };
  if (sealed.v !== 1 || !sealed.nonce || !sealed.ciphertext) return null;
  const aes = await aesKey(`live-dashboard-ai-config-store:${HASH_SECRET}`, ["decrypt"]);
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
  const aes = await aesKey(`live-dashboard-ai-config-store:${HASH_SECRET}`, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bufferSource(nonce) },
    aes,
    bufferSource(TEXT_ENCODER.encode(JSON.stringify(value))),
  );
  metaSet(key, JSON.stringify({
    v: 1,
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
  }));
}

async function aesKey(secret: string, usages: string[]): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest("SHA-256", bufferSource(TEXT_ENCODER.encode(secret)));
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, usages as never);
}

async function aesKeyFromShared(shared: Uint8Array, salt: Uint8Array, usages: string[]): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey("raw", bufferSource(shared), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: bufferSource(salt),
      info: TEXT_ENCODER.encode("live-dashboard-ai-config-x25519-v1"),
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

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
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

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlDecode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
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
