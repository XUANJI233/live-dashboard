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

  test("keeps the newest cross-device summary plan by client timestamp", async () => {
    const { getSummarySettings, updateSummarySettings } = await import("../src/services/daily-summary-gen");

    const newer = updateSummarySettings({
      mode: "normal",
      target: "finish the draft",
      planned_rest: false,
      weekly_plan: [{ weekday: 1, target: "write", planned_rest: true }],
      daily_summary_time: "21:00",
      weekly_summary_weekday: 7,
      weekly_summary_time: "21:30",
      client_updated_at: "2026-06-07T10:00:00.000Z",
    });
    expect(newer.sync_status).toBe("applied");
    expect(newer.target).toBe("finish the draft");
    expect(newer.weekly_plan[0]?.planned_rest).toBe(false);

    const stale = updateSummarySettings({
      target: "older stale draft",
      weekly_plan: [{ weekday: 1, target: "stale", planned_rest: true }],
      client_updated_at: "2026-06-07T09:00:00.000Z",
    });
    expect(stale.sync_status).toBe("ignored_stale");
    expect(stale.target).toBe("finish the draft");
    expect(stale.weekly_plan[0]?.target).toBe("write");

    const current = getSummarySettings();
    expect(current.sync_status).toBeUndefined();
    expect(current.target).toBe("finish the draft");
    expect(current.weekly_plan[0]?.target).toBe("write");
    expect(current.weekly_plan[0]?.planned_rest).toBe(false);

    const fresher = updateSummarySettings({
      target: "ship the draft",
      weekly_plan: [{ weekday: 1, target: "ship", planned_rest: false }],
      client_updated_at: "2026-06-07T11:00:00.000Z",
    });
    expect(fresher.sync_status).toBe("applied");
    expect(fresher.target).toBe("ship the draft");
    expect(fresher.weekly_plan[0]?.target).toBe("ship");

    const supervised = updateSummarySettings({
      target: "ship the draft",
      supervision_enabled: true,
      supervision_check_mode: "triggered",
      supervision_check_interval_minutes: 5,
      supervision_blacklist_minutes: 99,
      supervision_target_min_minutes: 0,
      supervision_vibrate: false,
      supervision_skip_watch_sleep: false,
      supervision_lsp_freeze: true,
      client_updated_at: "2026-06-07T12:00:00.000Z",
    });
    expect(supervised.sync_status).toBe("applied");
    expect(supervised.supervision_enabled).toBe(true);
    expect(supervised.supervision_check_mode).toBe("triggered");
    expect(supervised.supervision_check_interval_minutes).toBe(30);
    expect(supervised.supervision_blacklist_minutes).toBe(55);
    expect(supervised.supervision_target_min_minutes).toBe(1);
    expect(supervised.supervision_vibrate).toBe(false);
    expect(supervised.supervision_skip_watch_sleep).toBe(false);
    expect(supervised.supervision_lsp_freeze).toBe(true);
  });

  test("preserves bounded LSPosed frozen package records in device extras", async () => {
    const { processReportPayload } = await import("../src/services/device-status-handler");
    const { getAllDeviceStates } = await import("../src/db");
    const device = {
      device_id: "android-admin",
      device_name: "Android Admin",
      platform: "android" as const,
    };

    const result = processReportPayload({
      app_id: "com.example.reader",
      window_title: "reading",
      extra: {
        device: {
          capability_mode: "lsposed",
          frozen_packages: [
            {
              package_name: "com.example.shortvideo",
              app_name: "Short Video",
              frozen_at: "2026-06-07T12:00:00.000Z",
              until: "2026-06-07T12:10:00.000Z",
              reason: "偏离写作目标",
              ignored_payload: { nested: true },
            },
          ],
        },
      },
    }, device);

    expect(result?.extra.device).toEqual({
      capability_mode: "lsposed",
      frozen_packages: [{
        package_name: "com.example.shortvideo",
        app_name: "Short Video",
        frozen_at: "2026-06-07T12:00:00.000Z",
        until: "2026-06-07T12:10:00.000Z",
        reason: "偏离写作目标",
      }],
    });
    const row = (getAllDeviceStates.all() as { device_id: string; extra: string }[])
      .find((item) => item.device_id === "android-admin");
    expect(row?.extra).toContain("frozen_packages");
    expect(row?.extra).not.toContain("ignored_payload");
  });

  test("uses Vercel DeepSeek provider for DeepSeek endpoints", async () => {
    const { requestAiChatCompletion } = await import("../src/services/ai-config");
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      requested.push(url);
      expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
      const body = JSON.parse(String(init?.body || "{}"));
      expect(body.model).toBe("deepseek-chat");
      return Response.json({
        id: "deepseek-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "deepseek-chat",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 16,
          completion_tokens: 1,
          total_tokens: 17,
          prompt_cache_hit_tokens: 12,
          prompt_cache_miss_tokens: 4,
        },
      });
    }) as typeof fetch;
    try {
      const text = await requestAiChatCompletion({
        apiUrl: "https://api.deepseek.com/v1/chat/completions",
        apiKey: `deepseek-key-${randomHex(8)}`,
        model: "deepseek-chat",
      }, {
        messages: [
          { role: "system", content: "只返回 OK" },
          { role: "user", content: "ping" },
        ],
        maxTokens: 8,
        temperature: 0,
      });
      expect(text).toBe("OK");
      expect(requested).toEqual(["https://api.deepseek.com/v1/chat/completions"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("tests DeepSeek chat with an available model when the app still has the OpenAI default selected", async () => {
    const { testAiConfigConnection } = await import("../src/services/ai-config");
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      requested.push(url);
      if (url === "https://api.deepseek.com/models") {
        return Response.json({ data: [{ id: "deepseek-reasoner" }, { id: "deepseek-chat" }] });
      }
      if (url === "https://api.deepseek.com/chat/completions") {
        const body = JSON.parse(String(init?.body || "{}"));
        expect(body.model).toBe("deepseek-chat");
        return Response.json({
          id: "deepseek-test",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "deepseek-chat",
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
      const result = await testAiConfigConnection({
        apiUrl: "https://api.deepseek.com",
        apiKey: `deepseek-key-${randomHex(8)}`,
        model: "gpt-4o-mini",
      });
      expect(result.ok).toBe(true);
      expect(result.selected_model).toBe("deepseek-chat");
      expect(result.model_available).toBe(true);
      expect(result.message).toContain("已自动使用可用模型 deepseek-chat");
      expect(requested).toEqual([
        "https://api.deepseek.com/models",
        "https://api.deepseek.com/chat/completions",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reuses the stored AI key when the app leaves the key field blank", async () => {
    const {
      describeAiConfig,
      getAiRuntimeConfig,
      saveEncryptedAiConfigFromDevice,
      testEncryptedAiConfigFromDevice,
    } = await import("../src/services/ai-config");
    const token = `test-token-${randomHex(16)}`;
    const storedKey = `stored-ai-key-${randomHex(16)}`;
    const encryption = (await describeAiConfig()).encryption!;
    await saveEncryptedAiConfigFromDevice(await encryptAiConfigForServer(encryption.public_key, token, {
      api_url: "https://ai.example.invalid/v1/chat/completions",
      api_key: storedKey,
      model: "gpt-4o-mini",
    }), token);

    const reusePayload = await encryptAiConfigForServer(encryption.public_key, token, {
      api_url: "https://ai.example.invalid/v1/chat/completions",
      api_key: "",
      model: "gpt-4o-mini",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      const auth = init?.headers instanceof Headers
        ? init.headers.get("authorization")
        : (init?.headers as Record<string, string> | undefined)?.Authorization ??
          (init?.headers as Record<string, string> | undefined)?.authorization;
      expect(auth).toBe(`Bearer ${storedKey}`);
      if (url === "https://ai.example.invalid/v1/models") {
        return Response.json({ data: [{ id: "gpt-4o-mini" }] });
      }
      if (url === "https://ai.example.invalid/v1/chat/completions") {
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
      const tested = await testEncryptedAiConfigFromDevice(reusePayload, token);
      expect(tested.ok).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    await saveEncryptedAiConfigFromDevice(reusePayload, token);
    const runtime = await getAiRuntimeConfig();
    expect(runtime?.apiKey).toBe(storedKey);
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
