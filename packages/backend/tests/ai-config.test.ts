import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { x25519 } from "@noble/curves/ed25519.js";

const tempDir = mkdtempSync(join(tmpdir(), "live-ai-config-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = randomHex(32);
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
      modelsUrlFromAiApiUrl,
      describeAiConfig,
      getAiRuntimeConfig,
      saveEncryptedAiConfigFromDevice,
      testAiConfigConnection,
    } = await import("../src/services/ai-config");
    const token = `test-token-${randomHex(16)}`;
    const testAiKey = `test-ai-key-${randomHex(16)}`;

    const initial = await describeAiConfig();
    expect(initial.configured).toBe(false);
    expect(initial.locked).toBe(false);
    expect(initial.encryption?.alg).toBe("X25519-A256GCM-HS256");
    expect(typeof initial.encryption?.public_key).toBe("string");
    expect(initial.encryption?.public_key_sha256).toBe(await sha256Base64Url(base64UrlDecode(initial.encryption!.public_key)));

    await expect(saveEncryptedAiConfigFromDevice({
      api_url: "https://ai.example.invalid/v1/chat/completions",
      api_key: "plain-text-should-not-work",
      model: "gpt-4o-mini",
    }, token)).rejects.toMatchObject({ code: "AI_CONFIG_PAYLOAD_INVALID" });

    const payload = await encryptAiConfigForServer(initial.encryption!.public_key, token, {
      api_url: "https://ai.example.invalid/v1/chat/completions",
      api_key: testAiKey,
      model: "gpt-4o-mini",
    });
    const saved = await saveEncryptedAiConfigFromDevice(payload, token);
    expect(saved.configured).toBe(true);
    expect(saved.locked).toBe(false);
    expect(JSON.stringify(saved)).not.toContain(testAiKey);

    const runtime = await getAiRuntimeConfig();
    expect(runtime?.apiUrl).toBe("https://ai.example.invalid/v1/chat/completions");
    expect(runtime?.apiKey).toBe(testAiKey);
    expect(runtime?.source).toBe("server");

    const tamperedKeyPayload = await resignPayload({
      ...payload,
      server_public_key: base64UrlEncode(x25519.getPublicKey(x25519.utils.randomSecretKey())),
    }, token);
    await expect(saveEncryptedAiConfigFromDevice(tamperedKeyPayload, token))
      .rejects.toMatchObject({ code: "AI_CONFIG_SERVER_KEY_MISMATCH" });

    const unsafeUrlPayload = await encryptAiConfigForServer(initial.encryption!.public_key, token, {
      api_url: "https://ai.example.invalid/v1/chat/completions?key=hidden",
      api_key: testAiKey,
      model: "gpt-4o-mini",
    });
    await expect(saveEncryptedAiConfigFromDevice(unsafeUrlPayload, token))
      .rejects.toMatchObject({ code: "AI_URL_UNSAFE" });

    expect(modelsUrlFromAiApiUrl("https://ai.example.invalid/v1/chat/completions"))
      .toBe("https://ai.example.invalid/v1/models");

    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      requested.push(url);
      const auth = init?.headers instanceof Headers
        ? init.headers.get("authorization")
        : (init?.headers as Record<string, string> | undefined)?.Authorization ??
          (init?.headers as Record<string, string> | undefined)?.authorization;
      expect(auth).toBe(`Bearer ${testAiKey}`);
      if (url === "https://ai.example.invalid/v1/models") {
        return Response.json({ data: [{ id: "other-model" }, { id: "gpt-4o-mini" }] });
      }
      if (url === "https://ai.example.invalid/v1/chat/completions") {
        const body = JSON.parse(String(init?.body || "{}"));
        expect(body.model).toBe("gpt-4o-mini");
        expect(Array.isArray(body.messages)).toBe(true);
        return Response.json({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "gpt-4o-mini",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      return new Response("unexpected", { status: 404 });
    }) as typeof fetch;
    try {
      const tested = await testAiConfigConnection({
        apiUrl: "https://ai.example.invalid/v1/chat/completions",
        apiKey: testAiKey,
        model: "gpt-4o-mini",
      });
      expect(tested.ok).toBe(true);
      expect(tested.models).toEqual(["gpt-4o-mini", "other-model"]);
      expect(tested.model_available).toBe(true);
      expect(tested.models_url).toBe("https://ai.example.invalid/v1/models");
      expect(requested).toContain("https://ai.example.invalid/v1/models");
      expect(requested).toContain("https://ai.example.invalid/v1/chat/completions");
    } finally {
      globalThis.fetch = originalFetch;
    }
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
  const ts = Math.floor(Date.now() / 1000);
  const ephemeralPublicKey = base64UrlEncode(publicKey);
  const nonceText = base64UrlEncode(nonce);
  const signedMetadata = `2.${ts}.${serverPublicKey}.${ephemeralPublicKey}.${nonceText}`;
  const aesKey = await aesKeyFromShared(
    shared,
    nonce,
    ["encrypt"],
    encoder.encode(`live-dashboard-ai-config-x25519-v2.${serverPublicKey}.${ephemeralPublicKey}`),
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: bufferSource(nonce),
      additionalData: bufferSource(encoder.encode(signedMetadata)),
    },
    aesKey,
    bufferSource(encoder.encode(JSON.stringify(config))),
  );
  const ciphertextText = base64UrlEncode(new Uint8Array(ciphertext));
  const signed = `${signedMetadata}.${ciphertextText}`;
  const signature = await hmacBase64Url(token, signed);
  return {
    v: 2,
    alg: "X25519-A256GCM-HS256",
    ts,
    server_public_key: serverPublicKey,
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

async function resignPayload(payload: Record<string, unknown>, token: string): Promise<Record<string, unknown>> {
  const signedMetadata = [
    payload.v,
    payload.ts,
    payload.server_public_key,
    payload.ephemeral_public_key,
    payload.nonce,
  ].join(".");
  const signed = `${signedMetadata}.${payload.ciphertext}`;
  return {
    ...payload,
    signature: await hmacBase64Url(token, signed),
  };
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

function randomHex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

async function sha256Base64Url(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bufferSource(value));
  return base64UrlEncode(new Uint8Array(digest));
}

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
