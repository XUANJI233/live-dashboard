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
process.env.DEVICE_TOKEN_1 = "supervision-ack-token:ack-device:Ack Android:android";

const encoder = new TextEncoder();

describe("ai-config", () => {
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // The shared Bun test process keeps src/db open for other test files.
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
    const { db } = await import("../src/db");
    const { getSummarySettings, updateSummarySettings } = await import("../src/services/daily-summary-gen");

    db.prepare("DELETE FROM meta WHERE key = 'ai_summary_settings'").run();
    const newer = updateSummarySettings({
      mode: "normal",
      target: "finish the draft",
      planned_rest: false,
      weekly_plan: [{ weekday: 1, target: "write", planned_rest: true }],
      daily_summary_time: "21:00",
      weekly_summary_weekday: 7,
      weekly_summary_time: "21:30",
      timezone_offset_minutes: -480,
      client_updated_at: "2026-06-07T10:00:00.000Z",
    });
    expect(newer.sync_status).toBe("applied");
    expect(newer.target).toBe("finish the draft");
    expect(newer.weekly_plan[0]?.planned_rest).toBe(false);
    expect(newer.timezone_offset_minutes).toBe(-480);

    const stale = updateSummarySettings({
      target: "older stale draft",
      weekly_plan: [{ weekday: 1, target: "stale", planned_rest: true }],
      timezone_offset_minutes: 0,
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
    expect(current.timezone_offset_minutes).toBe(-480);

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

    const numericFlags = updateSummarySettings({
      planned_rest: 1,
      supervision_enabled: 1,
      supervision_vibrate: 1,
      client_updated_at: "2026-06-07T13:00:00.000Z",
    });
    expect(numericFlags.planned_rest).toBe(false);
    expect(numericFlags.supervision_enabled).toBe(false);
    expect(numericFlags.supervision_vibrate).toBe(false);
  });

  test("keeps summary settings API on snake_case fields and explicit booleans", async () => {
    const { db } = await import("../src/db");
    const { updateSummarySettings } = await import("../src/services/daily-summary-gen");

    db.prepare("DELETE FROM meta WHERE key = 'ai_summary_settings'").run();
    const camelCase = updateSummarySettings({
      plannedRest: true,
      supervisionEnabled: true,
      supervisionVibrate: false,
      supervisionLspFreeze: true,
      timezoneOffsetMinutes: -480,
      clientUpdatedAt: "2099-01-01T00:00:00.000Z",
      updated_at: "2099-01-01T00:00:00.000Z",
    });
    expect(camelCase.planned_rest).toBe(false);
    expect(camelCase.supervision_enabled).toBe(false);
    expect(camelCase.supervision_vibrate).toBe(true);
    expect(camelCase.supervision_lsp_freeze).toBe(false);
    expect(camelCase.timezone_offset_minutes).toBeNull();
    expect(camelCase.updated_at).not.toBe("2099-01-01T00:00:00.000Z");

    db.prepare("DELETE FROM meta WHERE key = 'ai_summary_settings'").run();
    const explicitOnly = updateSummarySettings({
      planned_rest: "true",
      supervision_enabled: "true",
      supervision_vibrate: "true",
      supervision_lsp_freeze: "true",
      supervision_check_mode: "threshold",
      client_updated_at: "2099-01-01T00:00:00.000Z",
    });
    expect(explicitOnly.planned_rest).toBe(false);
    expect(explicitOnly.supervision_enabled).toBe(false);
    expect(explicitOnly.supervision_vibrate).toBe(false);
    expect(explicitOnly.supervision_lsp_freeze).toBe(false);
    expect(explicitOnly.supervision_check_mode).toBe("hourly");
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
          profile: "android_lsp",
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
      profile: "android_lsp",
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
      expect(body.thinking).toEqual({ type: "enabled" });
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

  test("uses Vercel AI Gateway provider for gateway endpoints", async () => {
    const { requestAiChatCompletion } = await import("../src/services/ai-config");
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      requested.push(url);
      expect(url).toBe("https://ai-gateway.vercel.sh/v3/ai/language-model");
      const headers = init?.headers instanceof Headers
        ? init.headers
        : new Headers(init?.headers as Record<string, string> | undefined);
      expect(headers.get("authorization")).toBe("Bearer gateway-key");
      expect(headers.get("ai-language-model-id")).toBe("deepseek/deepseek-v3.2");
      const body = JSON.parse(String(init?.body || "{}"));
      expect(body.providerOptions?.deepseek?.thinking).toEqual({ type: "enabled" });
      expect(body.prompt.at(-1)?.role).toBe("user");
      return Response.json({
        content: [{ type: "text", text: "OK" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 16, noCache: 4, cacheRead: 12, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      });
    }) as typeof fetch;
    try {
      const text = await requestAiChatCompletion({
        apiUrl: "https://ai-gateway.vercel.sh/v3/ai",
        apiKey: "gateway-key",
        model: "deepseek/deepseek-v3.2",
      }, {
        messages: [
          { role: "system", content: "只返回 OK" },
          { role: "user", content: "ping" },
        ],
        maxTokens: 8,
        temperature: 0,
      });
      expect(text).toBe("OK");
      expect(requested).toEqual(["https://ai-gateway.vercel.sh/v3/ai/language-model"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("honors caller-provided AI chat timeouts", async () => {
    const { requestAiChatCompletion } = await import("../src/services/ai-config");
    const originalFetch = globalThis.fetch;
    const originalAbortSignalTimeout = AbortSignal.timeout;
    const delays: number[] = [];
    AbortSignal.timeout = ((timeout: number) => {
      delays.push(timeout);
      return originalAbortSignalTimeout(timeout);
    }) as typeof AbortSignal.timeout;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body || "{}"));
      return Response.json({
        id: "timeout-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;
    try {
      const text = await requestAiChatCompletion({
        apiUrl: "https://ai-timeout.example/v1/chat/completions",
        apiKey: `timeout-key-${randomHex(8)}`,
        model: "gpt-4o-mini",
      }, {
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 8,
        temperature: 0,
        timeoutMs: 20_000,
      });
      expect(text).toBe("OK");
      expect(delays).toContain(20_000);
      expect(delays).not.toContain(5 * 60_000);
    } finally {
      globalThis.fetch = originalFetch;
      AbortSignal.timeout = originalAbortSignalTimeout;
    }
  });

  test("primes DeepSeek context before the final chat request", async () => {
    const { requestAiChatCompletionWithCachePriming } = await import("../src/services/ai-config");
    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body || "{}"));
      bodies.push(body);
      const isWarmup = bodies.length === 1;
      if (isWarmup) {
        expect(body.max_tokens).toBe(32);
        expect(body.messages.at(-1)?.content).toContain("CONTEXT_READY");
      } else {
        expect(body.max_tokens).toBe(64);
        expect(body.messages.at(-3)?.content).toContain("CONTEXT_READY");
        expect(body.messages.at(-2)).toEqual({ role: "assistant", content: "{\"status\":\"CONTEXT_READY\"}" });
        expect(body.messages.at(-1)?.content).toBe("现在输出最终结果");
      }
      return Response.json({
        id: isWarmup ? "deepseek-cache-warmup-test" : "deepseek-cache-final-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: isWarmup ? "CONTEXT_READY" : "FINAL" },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: isWarmup ? 100 : 110,
          completion_tokens: 1,
          total_tokens: isWarmup ? 101 : 111,
          prompt_cache_hit_tokens: isWarmup ? 0 : 100,
          prompt_cache_miss_tokens: isWarmup ? 100 : 10,
        },
      });
    }) as typeof fetch;
    try {
      const text = await requestAiChatCompletionWithCachePriming({
        apiUrl: "https://api.deepseek.com/",
        apiKey: `deepseek-key-${randomHex(8)}`,
        model: "deepseek-chat",
      }, {
        messages: [
          { role: "system", content: "只按用户上下文回答" },
          { role: "user", content: "大段可缓存上下文" },
        ],
        finalUserMessage: "现在输出最终结果",
        maxTokens: 64,
        temperature: 0,
      });
      expect(text).toBe("FINAL");
      expect(bodies).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sends summary generation time in the requested local timezone after cacheable context", async () => {
    const { db } = await import("../src/db");
    const { describeAiConfig, saveEncryptedAiConfigFromDevice } = await import("../src/services/ai-config");
    const { generateDailySummary, getSummarySettings, saveSummarySettings } = await import("../src/services/daily-summary-gen");

    const suffix = randomHex(8);
    const token = `summary-local-time-token-${suffix}`;
    const encryption = (await describeAiConfig()).encryption!;
    await saveEncryptedAiConfigFromDevice(await encryptAiConfigForServer(encryption.public_key, token, {
      api_url: "https://api.deepseek.com/",
      api_key: `summary-local-time-key-${suffix}`,
      model: "deepseek-chat",
    }), token);

    saveSummarySettings({
      ...getSummarySettings(),
      target: "写代码",
      timezone_offset_minutes: -480,
      supervision_enabled: false,
    });
    db.prepare(`
      INSERT INTO activities (device_id, device_name, platform, app_id, app_name, window_title, display_title, extra, title_hash, time_bucket, started_at)
      VALUES (?, 'Summary Phone', 'android', 'com.microsoft.vscode', 'Code', 'project', 'project', '{}', ?, 10, ?)
    `).run(`summary-device-${suffix}`, `summary-hash-${suffix}`, "2026-06-08T00:00:00.000Z");
    db.prepare(`
      INSERT OR IGNORE INTO health_records (device_id, type, value, unit, recorded_at, end_time)
      VALUES (?, 'heart_rate', 72, 'bpm', '2026-06-08T00:15:00.000Z', '')
    `).run(`summary-device-${suffix}`);

    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body || "{}"));
      bodies.push(body);
      const messagesText = JSON.stringify(body.messages);
      if (bodies.length === 1) {
        expect(messagesText).toContain("CONTEXT_READY");
        expect(messagesText).toContain("2026-06-08 08:15");
        expect(messagesText).not.toContain("当前生成时间");
      } else {
        expect(body.messages.at(-1)?.content).toContain("当前生成时间:");
        expect(body.messages.at(-1)?.content).toContain("本地 ");
        expect(body.messages.at(-1)?.content).toContain("UTC+08:00");
        expect(body.messages.at(-1)?.content).toContain("日总结");
      }
      return Response.json({
        id: `summary-local-time-${bodies.length}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: bodies.length === 1 ? "CONTEXT_READY" : "今天主要在 Code 里推进项目，节奏集中但记录较短。明天继续围绕写代码目标推进。" },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: bodies.length === 1 ? 80 : 90,
          completion_tokens: 1,
          total_tokens: bodies.length === 1 ? 81 : 91,
          prompt_cache_hit_tokens: bodies.length === 1 ? 0 : 80,
          prompt_cache_miss_tokens: bodies.length === 1 ? 80 : 10,
        },
      });
    }) as typeof fetch;

    try {
      const result = await generateDailySummary({ date: "2026-06-08", tzOffsetMinutes: -480 });
      expect(result.ok).toBe(true);
      expect(result.summary).toContain("Code");
      expect(bodies).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("enables DeepSeek thinking mode and forwards the requested output budget", async () => {
    const { requestAiChatCompletion } = await import("../src/services/ai-config");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body || "{}"));
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.max_tokens).toBe(8192);
      return Response.json({
        id: "deepseek-thinking-budget-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: "{\"ok\":true}" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
      });
    }) as typeof fetch;
    try {
      const text = await requestAiChatCompletion({
        apiUrl: "https://api.deepseek.com/",
        apiKey: `deepseek-key-${randomHex(8)}`,
        model: "deepseek-v4-flash",
      }, {
        messages: [
          { role: "system", content: "只返回严格 JSON" },
          { role: "user", content: "返回 {\"ok\":true}" },
        ],
        maxTokens: 8192,
        temperature: 0,
      });
      expect(text).toBe("{\"ok\":true}");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retries empty AI responses before failing the chat request", async () => {
    const { requestAiChatCompletion } = await import("../src/services/ai-config");
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls += 1;
      const body = JSON.parse(String(init?.body || "{}"));
      if (calls < 4) {
        return Response.json({
          id: "empty-ai-response-test",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{
            index: 0,
            message: { role: "assistant", content: "" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
        });
      }
      return Response.json({
        id: "empty-ai-response-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;
    try {
      const text = await requestAiChatCompletion({
        apiUrl: "https://api.deepseek.com/",
        apiKey: `deepseek-key-${randomHex(8)}`,
        model: "deepseek-v4-flash",
      }, {
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 8192,
        temperature: 0,
      });
      expect(text).toBe("OK");
      expect(calls).toBe(4);
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
        expect(body.thinking).toEqual({ type: "enabled" });
        expect(body.max_tokens).toBe(8192);
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

  test("normalizes DeepSeek inline regex flags in generated supervision rules", async () => {
    const { describeAiConfig, saveEncryptedAiConfigFromDevice } = await import("../src/services/ai-config");
    const { getSummarySettings } = await import("../src/services/daily-summary-gen");
    const { refreshSupervisionRules } = await import("../src/services/supervision");
    const token = `test-token-${randomHex(16)}`;
    const encryption = (await describeAiConfig()).encryption!;
    await saveEncryptedAiConfigFromDevice(await encryptAiConfigForServer(encryption.public_key, token, {
      api_url: "https://api.deepseek.com/",
      api_key: `deepseek-key-${randomHex(8)}`,
      model: "deepseek-v4-flash",
    }), token);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      expect(url).toBe("https://api.deepseek.com/chat/completions");
      const body = JSON.parse(String(init?.body || "{}"));
      expect(body.max_tokens).toBe(8192);
      expect(body.thinking).toEqual({ type: "enabled" });
      return Response.json({
        id: "deepseek-supervision-rules-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({
              whitelist_app_regex: ["(?i)^com\\.android\\.", "(?i:Live Dashboard)", "new RegExp(\"com\\\\.example\", \"i\")"],
              blacklist_app_regex: ["RegExp(\"(?:douyin|tiktok)\", \"i\")"],
              risk_app_regex: ["RegExp(\"(?:youtube|bilibili)\", \"i\")"],
              target_app_regex: ["new RegExp(\"Code\", \"i\")"],
              reason: "test",
            }),
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
    }) as typeof fetch;
    try {
      const settings = {
        ...getSummarySettings(),
        target: "专注开发 Live Dashboard",
        supervision_enabled: true,
      };
      const result = await refreshSupervisionRules(settings);
      expect(result.supervision_rules_error).toBeNull();
      expect(result.supervision_rules.whitelist_app_regex).toEqual(["^com\\.android\\.", "(?:Live Dashboard)", "com\\.example"]);
      expect(result.supervision_rules.blacklist_app_regex).toEqual(["(?:douyin|tiktok)"]);
      expect(result.supervision_rules.risk_app_regex).toEqual(["(?:youtube|bilibili)"]);
      expect(result.supervision_rules.target_app_regex).toEqual(["Code"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps supervision final instruction when retrying invalid JSON", async () => {
    const { describeAiConfig, saveEncryptedAiConfigFromDevice } = await import("../src/services/ai-config");
    const { getSummarySettings } = await import("../src/services/daily-summary-gen");
    const { refreshSupervisionRules } = await import("../src/services/supervision");
    const token = `retry-json-token-${randomHex(16)}`;
    const encryption = (await describeAiConfig()).encryption!;
    await saveEncryptedAiConfigFromDevice(await encryptAiConfigForServer(encryption.public_key, token, {
      api_url: "https://ai-retry.example/v1/chat/completions",
      api_key: `ai-retry-key-${randomHex(8)}`,
      model: "gpt-4o-mini",
    }), token);

    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body || "{}"));
      bodies.push(body);
      const isRetry = bodies.length === 2;
      if (isRetry) {
        const messagesText = JSON.stringify(body.messages);
        expect(messagesText).toContain("现在根据以上全部上下文生成监督规则 JSON");
        expect(messagesText).toContain("上一次响应不是合法的监督规则 JSON");
      }
      return Response.json({
        id: isRetry ? "supervision-retry-valid" : "supervision-retry-invalid",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: isRetry
              ? JSON.stringify({
                  whitelist_app_regex: ["Code"],
                  blacklist_app_regex: ["TikTok"],
                  risk_app_regex: ["YouTube"],
                  target_app_regex: ["Code"],
                  reason: "retry ok",
                })
              : "not json",
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
    }) as typeof fetch;
    try {
      const result = await refreshSupervisionRules({
        ...getSummarySettings(),
        target: "写代码",
        supervision_enabled: true,
      });
      expect(result.supervision_rules_error).toBeNull();
      expect(result.supervision_rules.blacklist_app_regex).toEqual(["TikTok"]);
      expect(result.supervision_rules.risk_app_regex).toEqual(["YouTube"]);
      expect(bodies).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps older public messages visible in the default recent window", async () => {
    const { db } = await import("../src/db");
    const { handlePublicMessages } = await import("../src/services/realtime");
    const id = `public-old-${randomHex(8)}`;
    const createdAt = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
    db.prepare(`
      INSERT INTO visitor_messages (id, device_id, viewer_id, viewer_name, kind, direction, text, created_at)
      VALUES (?, '__public__', 'viewer-test', 'tester', 'public', 'viewer', 'old public message', ?)
    `).run(id, createdAt);

    const response = handlePublicMessages(new Request("https://example.test/api/messages/public?recent=1"));
    const body = await response.json() as { messages?: Array<{ id?: string }> };
    expect(body.messages?.some((message) => message.id === id)).toBe(true);
  });

  test("confirms device command receipt and result over HTTP fallback", async () => {
    const { db } = await import("../src/db");
    const { handleSupervisionAck } = await import("../src/routes/supervision-ack");
    const { sendDeviceCommands } = await import("../src/services/device-control");
    const requestId = `req_http_ack_${randomHex(8)}`;
    db.prepare(`
      INSERT OR REPLACE INTO device_states (
        device_id, device_name, platform, app_id, app_name, window_title, display_title, last_seen_at, extra, is_online
      )
      VALUES ('ack-device', 'Ack Android', 'android', 'idle', 'Idle', '', 'Idle', ?, ?, 1)
    `).run(
      new Date().toISOString(),
      JSON.stringify({ device: { profile: "android_lsp" } }),
    );
    const sent = sendDeviceCommands({
      request_id: requestId,
      commands: [{ device_id: "ack-device", say: "同步状态" }],
    });
    const command = sent.commands[0]!;

    const receiptResponse = await handleSupervisionAck(new Request("https://example.test/api/supervision/ack", {
      method: "POST",
      headers: {
        Authorization: "Bearer supervision-ack-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "device_command_receipt",
        request_id: requestId,
        command_id: command.command_id,
        status: "received",
        received_at: "2026-06-10T10:00:00.000Z",
      }),
    }));
    expect(receiptResponse.status).toBe(200);
    await expect(receiptResponse.json()).resolves.toEqual({
      received: true,
      command_id: command.command_id,
      request_id: requestId,
    });

    const resultResponse = await handleSupervisionAck(new Request("https://example.test/api/supervision/ack", {
      method: "POST",
      headers: {
        Authorization: "Bearer supervision-ack-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "device_command_result",
        request_id: requestId,
        command_id: command.command_id,
        result_id: `res_http_ack_${randomHex(8)}`,
        status: "applied",
        executed_at: "2026-06-10T10:00:01.000Z",
        actions: [{ action: "say", status: "applied" }],
        state_after: {},
      }),
    }));
    expect(resultResponse.status).toBe(200);
    const resultBody = await resultResponse.json() as Record<string, unknown>;
    expect(resultBody).toMatchObject({
      received: true,
      command_id: command.command_id,
      request_id: requestId,
      duplicate: false,
    });
    expect(typeof resultBody.result_id).toBe("string");

  });

  test("delivers AI unfreeze device commands", async () => {
    const { db } = await import("../src/db");
    const {
      describeAiConfig,
      saveEncryptedAiConfigFromDevice,
    } = await import("../src/services/ai-config");
    const {
      getSummarySettings,
      saveSummarySettings,
    } = await import("../src/services/daily-summary-gen");
    const { runSupervisionTick } = await import("../src/services/supervision");

    const suffix = randomHex(8);
    const token = `supervision-token-${suffix}`;
    const deviceId = `android-unfreeze-${suffix}`;
    const checkedAt = new Date("2026-06-07T12:00:00.000Z");
    const encryption = (await describeAiConfig()).encryption!;
    await saveEncryptedAiConfigFromDevice(await encryptAiConfigForServer(encryption.public_key, token, {
      api_url: "https://ai-unfreeze.example/v1/chat/completions",
      api_key: `ai-unfreeze-key-${suffix}`,
      model: "gpt-4o-mini",
    }), token);

    saveSummarySettings({
      ...getSummarySettings(),
      target: "写代码",
      supervision_enabled: true,
      supervision_check_mode: "hourly",
      supervision_skip_watch_sleep: false,
      supervision_lsp_freeze: true,
      supervision_rules: {
        whitelist_app_regex: ["Code"],
        blacklist_app_regex: ["Short Video"],
        risk_app_regex: [],
        target_app_regex: ["Code"],
        reason: "test",
      },
    });

    db.prepare(`
      INSERT INTO device_states (device_id, device_name, platform, app_id, app_name, window_title, display_title, last_seen_at, extra, is_online)
      VALUES (?, 'Android phone', 'android', 'com.example.shortvideo', 'Short Video', '', 'Short Video', ?, ?, 1)
    `).run(deviceId, checkedAt.toISOString(), JSON.stringify({
      device: {
        profile: "android_lsp",
        frozen_packages: [{
          package_name: "com.example.shortvideo",
          app_name: "Short Video",
          reason: "偏离写代码目标",
        }],
      },
    }));
    db.prepare(`
      INSERT INTO activities (device_id, device_name, platform, app_id, app_name, window_title, display_title, extra, title_hash, time_bucket, started_at)
      VALUES (?, 'Android phone', 'android', 'com.microsoft.vscode', 'Code', 'project', 'project', '{}', ?, 1, ?)
    `).run(deviceId, `hash-${suffix}`, new Date(checkedAt.getTime() - 20 * 60_000).toISOString());

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body || "{}"));
      expect(body.messages.at(-1)?.content).toContain("监督复核 JSON");
      expect(JSON.stringify(body.messages)).toContain("设备能力与当前已冻结列表 JSON");
      return Response.json({
        id: "chatcmpl-unfreeze-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({
              "设备命令": [{
                device_id: deviceId,
                "是否偏离": false,
                "原因": "已回到目标任务",
                "冻结命令": [],
                "解冻命令": ["全部"],
                "是否震动": false,
                "是否息屏": false,
                "要说的话": "已回到目标任务",
              }],
            }),
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      });
    }) as typeof fetch;

    try {
      await runSupervisionTick(checkedAt, { force: true });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const row = db.prepare(`
      SELECT payload
      FROM device_commands
      WHERE target_device_id = ?
      ORDER BY issued_at DESC
      LIMIT 1
    `).get(deviceId) as { payload?: string } | null;
    const envelope = JSON.parse(row?.payload || "{}") as Record<string, any>;
    expect(envelope.type).toBe("device_command");
    expect(envelope.target_device_id).toBe(deviceId);
    expect(envelope.payload.kind).toBe("supervision");
    expect(envelope.payload.unfreeze_commands).toEqual(["全部"]);
    expect(envelope.payload.freeze_commands).toEqual([]);
    expect(envelope.payload.screen_off).toBe(false);
    expect("unfreeze" in envelope.payload).toBe(false);
    expect("unfreeze_all" in envelope.payload).toBe(false);
    expect("unfreeze_regex" in envelope.payload).toBe(false);
    expect(Date.parse(String(envelope.issued_at))).toBeGreaterThanOrEqual(checkedAt.getTime());
  });

  test("releases pending risk freeze even when formal LSP freeze is disabled", async () => {
    const { db } = await import("../src/db");
    const {
      describeAiConfig,
      saveEncryptedAiConfigFromDevice,
    } = await import("../src/services/ai-config");
    const {
      getSummarySettings,
      saveSummarySettings,
    } = await import("../src/services/daily-summary-gen");
    const { runSupervisionTick } = await import("../src/services/supervision");

    const suffix = randomHex(8);
    const token = `supervision-pending-risk-token-${suffix}`;
    const deviceId = `android-pending-risk-${suffix}`;
    const checkedAt = new Date("2026-06-07T12:30:00.000Z");
    const encryption = (await describeAiConfig()).encryption!;
    await saveEncryptedAiConfigFromDevice(await encryptAiConfigForServer(encryption.public_key, token, {
      api_url: "https://ai-pending-risk.example/v1/chat/completions",
      api_key: `ai-pending-risk-key-${suffix}`,
      model: "gpt-4o-mini",
    }), token);

    db.prepare("DELETE FROM meta WHERE key IN ('supervision_last_alert_at', 'supervision_last_ai_check_at')").run();
    saveSummarySettings({
      ...getSummarySettings(),
      target: "写代码",
      supervision_enabled: true,
      supervision_check_mode: "hourly",
      supervision_check_interval_minutes: 60,
      supervision_blacklist_minutes: 1,
      supervision_vibrate: false,
      supervision_skip_watch_sleep: false,
      supervision_lsp_freeze: false,
      supervision_rules: {
        whitelist_app_regex: ["Code"],
        blacklist_app_regex: ["Short Video"],
        risk_app_regex: ["Short Video"],
        target_app_regex: ["Code"],
        reason: "test",
      },
    });

    db.prepare(`
      INSERT INTO device_states (device_id, device_name, platform, app_id, app_name, window_title, display_title, last_seen_at, extra, is_online)
      VALUES (?, 'Android phone', 'android', 'com.example.shortvideo', 'Short Video', '', 'Short Video', ?, ?, 1)
    `).run(deviceId, checkedAt.toISOString(), JSON.stringify({
      device: {
        profile: "android_lsp",
        frozen_packages: [{
          package_name: "com.example.shortvideo",
          app_name: "Short Video",
          reason: "pending_supervision_review",
        }],
      },
    }));
    db.prepare(`
      INSERT INTO activities (device_id, device_name, platform, app_id, app_name, window_title, display_title, extra, title_hash, time_bucket, started_at)
      VALUES (?, 'Android phone', 'android', 'com.example.shortvideo', 'Short Video', 'short video', 'short video', '{}', ?, 1, ?)
    `).run(deviceId, `hash-pending-risk-${suffix}`, new Date(checkedAt.getTime() - 20 * 60_000).toISOString());

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("simulated AI outage");
    }) as unknown as typeof fetch;

    try {
      await runSupervisionTick(checkedAt, { force: true });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const row = db.prepare(`
      SELECT payload
      FROM device_commands
      WHERE target_device_id = ?
      ORDER BY issued_at DESC
      LIMIT 1
    `).get(deviceId) as { payload?: string } | null;
    const envelope = JSON.parse(row?.payload || "{}") as Record<string, any>;
    expect(envelope.type).toBe("device_command");
    expect(envelope.target_device_id).toBe(deviceId);
    expect(envelope.payload.kind).toBe("supervision");
    expect(envelope.payload.freeze_commands).toEqual([]);
    expect(envelope.payload.unfreeze_commands).toEqual(["pending_supervision_review"]);
    expect(envelope.payload.vibrate).toBe(false);
  });

  test("translates AI freeze command arrays into device command payloads", async () => {
    const { db } = await import("../src/db");
    const {
      describeAiConfig,
      saveEncryptedAiConfigFromDevice,
    } = await import("../src/services/ai-config");
    const {
      getSummarySettings,
      saveSummarySettings,
    } = await import("../src/services/daily-summary-gen");
    const { runSupervisionTick } = await import("../src/services/supervision");

    const suffix = randomHex(8);
    const token = `supervision-freeze-token-${suffix}`;
    const deviceId = `android-freeze-${suffix}`;
    const checkedAt = new Date("2026-06-07T13:00:00.000Z");
    const encryption = (await describeAiConfig()).encryption!;
    await saveEncryptedAiConfigFromDevice(await encryptAiConfigForServer(encryption.public_key, token, {
      api_url: "https://ai-freeze.example/v1/chat/completions",
      api_key: `ai-freeze-key-${suffix}`,
      model: "gpt-4o-mini",
    }), token);

    db.prepare("DELETE FROM meta WHERE key IN ('supervision_last_alert_at', 'supervision_last_ai_check_at')").run();
    saveSummarySettings({
      ...getSummarySettings(),
      target: "写代码",
      supervision_enabled: true,
      supervision_check_mode: "hourly",
      supervision_check_interval_minutes: 60,
      supervision_vibrate: true,
      supervision_skip_watch_sleep: false,
      supervision_lsp_freeze: true,
      supervision_rules: {
        whitelist_app_regex: ["Code"],
        blacklist_app_regex: ["TikTok", "VPN"],
        risk_app_regex: [],
        target_app_regex: ["Code"],
        reason: "test",
      },
    });

    db.prepare(`
      INSERT INTO device_states (device_id, device_name, platform, app_id, app_name, window_title, display_title, last_seen_at, extra, is_online)
      VALUES (?, 'Android phone', 'android', 'com.zhiliaoapp.musically', 'TikTok', '', 'TikTok', ?, ?, 1)
    `).run(deviceId, checkedAt.toISOString(), JSON.stringify({
      device: {
        profile: "android_lsp",
        frozen_packages: [],
      },
    }));
    db.prepare(`
      INSERT INTO activities (device_id, device_name, platform, app_id, app_name, window_title, display_title, extra, title_hash, time_bucket, started_at)
      VALUES (?, 'Android phone', 'android', 'com.zhiliaoapp.musically', 'TikTok', 'short video', 'short video', '{}', ?, 2, ?)
    `).run(deviceId, `hash-freeze-${suffix}`, new Date(checkedAt.getTime() - 35 * 60_000).toISOString());

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body || "{}"));
      expect(JSON.stringify(body.messages)).toContain("新增时间线 JSON");
      return Response.json({
        id: "chatcmpl-freeze-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({
              "设备命令": [{
                device_id: deviceId,
                "是否偏离": true,
                "原因": "短视频偏离写代码目标",
                "冻结命令": ["com\\.zhiliaoapp\\.musically", "Clash|VPN"],
                "解冻命令": [],
                "是否震动": false,
                "是否息屏": false,
                "要说的话": "先断开短视频和代理，回到代码。",
              }],
            }),
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      });
    }) as typeof fetch;

    try {
      await runSupervisionTick(checkedAt, { force: true });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const row = db.prepare(`
      SELECT payload
      FROM device_commands
      WHERE target_device_id = ?
      ORDER BY issued_at DESC
      LIMIT 1
    `).get(deviceId) as { payload?: string } | null;
    const envelope = JSON.parse(row?.payload || "{}") as Record<string, any>;
    expect(envelope.type).toBe("device_command");
    expect(envelope.target_device_id).toBe(deviceId);
    expect(envelope.payload.vibrate).toBe(false);
    expect(envelope.payload.screen_off).toBe(false);
    expect(envelope.payload.freeze_commands).toEqual(["com\\.zhiliaoapp\\.musically", "Clash|VPN"]);
    expect(envelope.payload.unfreeze_commands).toEqual([]);
    expect("freeze" in envelope.payload).toBe(false);
    expect("violation_regex" in envelope.payload).toBe(false);
  });

  test("routes supervision commands by device capability", async () => {
    const { db } = await import("../src/db");
    const {
      describeAiConfig,
      saveEncryptedAiConfigFromDevice,
    } = await import("../src/services/ai-config");
    const {
      getSummarySettings,
      saveSummarySettings,
    } = await import("../src/services/daily-summary-gen");
    const { runSupervisionTick } = await import("../src/services/supervision");

    const suffix = randomHex(8);
    const token = `supervision-route-token-${suffix}`;
    const lspId = `android-lsp-${suffix}`;
    const normalId = `android-normal-${suffix}`;
    const desktopId = `desktop-${suffix}`;
    const checkedAt = new Date("2026-06-07T14:00:00.000Z");
    const encryption = (await describeAiConfig()).encryption!;
    await saveEncryptedAiConfigFromDevice(await encryptAiConfigForServer(encryption.public_key, token, {
      api_url: "https://ai-route.example/v1/chat/completions",
      api_key: `ai-route-key-${suffix}`,
      model: "gpt-4o-mini",
    }), token);

    db.prepare("DELETE FROM meta WHERE key IN ('supervision_last_alert_at', 'supervision_last_ai_check_at')").run();
    saveSummarySettings({
      ...getSummarySettings(),
      target: "写代码",
      supervision_enabled: true,
      supervision_check_mode: "hourly",
      supervision_check_interval_minutes: 60,
      supervision_vibrate: true,
      supervision_skip_watch_sleep: false,
      supervision_lsp_freeze: true,
      supervision_rules: {
        whitelist_app_regex: ["Code"],
        blacklist_app_regex: ["TikTok", "Game"],
        risk_app_regex: [],
        target_app_regex: ["Code"],
        reason: "test",
      },
    });

    const insertDevice = db.prepare(`
      INSERT INTO device_states (device_id, device_name, platform, app_id, app_name, window_title, display_title, last_seen_at, extra, is_online)
      VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, 1)
    `);
    insertDevice.run(lspId, "LSP Android", "android", "com.zhiliaoapp.musically", "TikTok", "TikTok", checkedAt.toISOString(), JSON.stringify({
      device: { profile: "android_lsp", frozen_packages: [] },
    }));
    insertDevice.run(normalId, "Normal Android", "android", "com.example.game", "Game", "Game", checkedAt.toISOString(), JSON.stringify({
      device: { profile: "android_normal", frozen_packages: [] },
    }));
    insertDevice.run(desktopId, "Desktop", "windows", "steam", "Game", "Game", checkedAt.toISOString(), "{}");

    const insertActivity = db.prepare(`
      INSERT INTO activities (device_id, device_name, platform, app_id, app_name, window_title, display_title, extra, title_hash, time_bucket, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)
    `);
    insertActivity.run(lspId, "LSP Android", "android", "com.zhiliaoapp.musically", "TikTok", "short video", "short video", `hash-lsp-${suffix}`, 3, new Date(checkedAt.getTime() - 30 * 60_000).toISOString());
    insertActivity.run(normalId, "Normal Android", "android", "com.example.game", "Game", "game", "game", `hash-normal-${suffix}`, 4, new Date(checkedAt.getTime() - 25 * 60_000).toISOString());
    insertActivity.run(desktopId, "Desktop", "windows", "steam", "Game", "game", "game", `hash-desktop-${suffix}`, 5, new Date(checkedAt.getTime() - 20 * 60_000).toISOString());

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body || "{}"));
      expect(JSON.stringify(body.messages)).toContain("android_lsp");
      expect(JSON.stringify(body.messages)).toContain("desktop_message");
      return Response.json({
        id: "chatcmpl-route-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({
              "设备命令": [
                {
                  device_id: lspId,
                  "是否偏离": true,
                  "原因": "短视频偏离写代码目标",
                  "冻结命令": ["com\\.zhiliaoapp\\.musically", "VPN"],
                  "解冻命令": [],
                  "是否震动": true,
                  "是否息屏": true,
                  "要说的话": "先停短视频。",
                },
                {
                  device_id: normalId,
                  "是否偏离": true,
                  "原因": "普通安卓只能提醒",
                  "冻结命令": ["com\\.example\\.game"],
                  "解冻命令": [],
                  "是否震动": true,
                  "是否息屏": true,
                  "要说的话": "先离开游戏。",
                },
                {
                  device_id: desktopId,
                  "是否偏离": true,
                  "原因": "桌面端只发提醒",
                  "冻结命令": ["steam"],
                  "解冻命令": ["全部"],
                  "是否震动": true,
                  "是否息屏": true,
                  "要说的话": "桌面端回到代码。",
                },
              ],
            }),
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      });
    }) as typeof fetch;

    try {
      await runSupervisionTick(checkedAt, { force: true });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const rows = db.prepare(`
      SELECT target_device_id, payload
      FROM device_commands
      WHERE target_device_id IN (?, ?, ?)
      ORDER BY target_device_id ASC
    `).all(lspId, normalId, desktopId) as { target_device_id: string; payload?: string }[];
    const payloadByDevice = new Map(rows.map((row) => {
      const envelope = JSON.parse(row.payload || "{}") as Record<string, any>;
      return [row.target_device_id, envelope.payload as Record<string, unknown>];
    }));

    const lspPayload = payloadByDevice.get(lspId)!;
    expect(lspPayload.vibrate).toBe(true);
    expect(lspPayload.screen_off).toBe(false);
    expect(lspPayload.freeze_commands).toEqual(["com\\.zhiliaoapp\\.musically", "VPN"]);
    expect(lspPayload.unfreeze_commands).toEqual([]);
    expect("freeze" in lspPayload).toBe(false);
    expect("violation_regex" in lspPayload).toBe(false);

    const normalPayload = payloadByDevice.get(normalId)!;
    expect(normalPayload.vibrate).toBe(true);
    expect(normalPayload.screen_off).toBe(false);
    expect(normalPayload.freeze_commands).toEqual([]);
    expect(normalPayload.unfreeze_commands).toEqual([]);
    expect("freeze" in normalPayload).toBe(false);
    expect("violation_regex" in normalPayload).toBe(false);

    const desktopPayload = payloadByDevice.get(desktopId)!;
    expect(desktopPayload.vibrate).toBe(false);
    expect(desktopPayload.screen_off).toBe(false);
    expect(desktopPayload.unfreeze_commands).toEqual([]);
    expect(desktopPayload.freeze_commands).toEqual([]);
    expect("unfreeze" in desktopPayload).toBe(false);
    expect("unfreeze_all" in desktopPayload).toBe(false);
    expect("unfreeze_regex" in desktopPayload).toBe(false);
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
