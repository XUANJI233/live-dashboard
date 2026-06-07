import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { x25519 } from "@noble/curves/ed25519.js";

const tempDir = mkdtempSync(join(tmpdir(), "live-ai-config-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
delete process.env.AI_API_URL;
delete process.env.AI_API_KEY;

const encoder = new TextEncoder();

describe("ai-config", () => {
  afterAll(async () => {
    const { db } = await import("../src/db");
    db.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // SQLite can release WAL/SHM handles slightly after close on Windows.
    }
  });

  test("accepts only encrypted AI config payloads", async () => {
    const {
      describeAiConfig,
      getAiRuntimeConfig,
      saveEncryptedAiConfigFromDevice,
    } = await import("../src/services/ai-config");
    const token = "device-token-for-ai-config";

    const initial = await describeAiConfig();
    expect(initial.configured).toBe(false);
    expect(initial.locked).toBe(false);
    expect(initial.encryption?.alg).toBe("X25519-A256GCM-HS256");
    expect(typeof initial.encryption?.public_key).toBe("string");

    await expect(saveEncryptedAiConfigFromDevice({
      api_url: "https://ai.example.invalid/v1/chat/completions",
      api_key: "plain-text-should-not-work",
      model: "gpt-4o-mini",
    }, token)).rejects.toMatchObject({ code: "AI_CONFIG_PAYLOAD_INVALID" });

    const payload = await encryptAiConfigForServer(initial.encryption!.public_key, token, {
      api_url: "https://ai.example.invalid/v1/chat/completions",
      api_key: "sk-test-encrypted-only",
      model: "gpt-4o-mini",
    });
    const saved = await saveEncryptedAiConfigFromDevice(payload, token);
    expect(saved.configured).toBe(true);
    expect(saved.locked).toBe(false);
    expect(JSON.stringify(saved)).not.toContain("sk-test-encrypted-only");

    const runtime = await getAiRuntimeConfig();
    expect(runtime?.apiUrl).toBe("https://ai.example.invalid/v1/chat/completions");
    expect(runtime?.apiKey).toBe("sk-test-encrypted-only");
    expect(runtime?.source).toBe("server");
  });
});

async function encryptAiConfigForServer(
  serverPublicKey: string,
  token: string,
  config: Record<string, string>,
): Promise<Record<string, unknown>> {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const shared = x25519.getSharedSecret(privateKey, base64UrlDecode(serverPublicKey));
  const aesKey = await aesKeyFromShared(shared, nonce, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bufferSource(nonce) },
    aesKey,
    bufferSource(encoder.encode(JSON.stringify(config))),
  );
  const ts = Math.floor(Date.now() / 1000);
  const ephemeralPublicKey = base64UrlEncode(publicKey);
  const nonceText = base64UrlEncode(nonce);
  const ciphertextText = base64UrlEncode(new Uint8Array(ciphertext));
  const signed = `1.${ts}.${ephemeralPublicKey}.${nonceText}.${ciphertextText}`;
  const signature = await hmacBase64Url(token, signed);
  return {
    v: 1,
    alg: "X25519-A256GCM-HS256",
    ts,
    ephemeral_public_key: ephemeralPublicKey,
    nonce: nonceText,
    ciphertext: ciphertextText,
    signature,
  };
}

async function aesKeyFromShared(
  shared: Uint8Array,
  salt: Uint8Array,
  usages: string[],
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey("raw", bufferSource(shared), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: bufferSource(salt),
      info: encoder.encode("live-dashboard-ai-config-x25519-v1"),
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
    bufferSource(encoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, bufferSource(encoder.encode(data)));
  return base64UrlEncode(new Uint8Array(signature));
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
