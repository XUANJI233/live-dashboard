import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-supervision-policy-ownership-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
process.env.AI_API_URL = "https://ai.example.test/v1/";
process.env.AI_API_KEY = "policy-ownership-test-key";
delete process.env.HERMES_CONTROLLER_ENABLED;

const { getSummarySettings, saveSummarySettings, updateSummarySettings } = await import("../src/services/daily-summary-gen");
const { setAndSendSupervisionPolicy } = await import("../src/services/supervision-policy-control");
const { updateControllerPersona } = await import("../src/services/controller-persona");
const { refreshSupervisionRules } = await import("../src/services/supervision");

updateControllerPersona({ enabled: true, controller: "hermes" });

function policy(extra: Record<string, unknown> = {}) {
  return {
    policy_owner: "hermes" as const,
    strategy_reason: "Hermes strategy for the current goal",
    review_interval_minutes: 30,
    risk_app_regex: ["com\\.example\\.game"],
    risk_trigger_minutes: 4,
    app_time_limits: [{ app_regex: "com\\.example\\.video", limit_minutes: 20 }],
    ...extra,
  };
}

function rulesReply(content: Record<string, unknown>, during?: () => void) {
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    during?.();
    const body = JSON.parse(String(init?.body || "{}")) as { model?: string };
    return Response.json({
      id: "rules-test",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(content) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }) as typeof fetch;
}

describe("supervision policy ownership", () => {
  const originalFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = originalFetch;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite file locked until the process exits.
    }
  });

  test("the controller writes the classification lists as part of the complete snapshot", () => {
    setAndSendSupervisionPolicy(policy({
      whitelist_app_regex: ["com\\.example\\.notes"],
      blacklist_app_regex: ["com\\.example\\.video"],
      target_app_regex: ["com\\.example\\.ide"],
    }));
    expect(getSummarySettings().supervision_rules).toMatchObject({
      whitelist_app_regex: ["com\\.example\\.notes"],
      blacklist_app_regex: ["com\\.example\\.video"],
      risk_app_regex: ["com\\.example\\.game"],
      target_app_regex: ["com\\.example\\.ide"],
    });

    setAndSendSupervisionPolicy(policy());
    expect(getSummarySettings().supervision_rules).toMatchObject({
      whitelist_app_regex: [],
      blacklist_app_regex: [],
      target_app_regex: [],
    });
  });

  test("a regex the server would drop is rejected instead of being sent to devices", () => {
    const before = getSummarySettings().supervision_policy_updated_at;
    expect(() => setAndSendSupervisionPolicy(policy({ blacklist_app_regex: [".*"] }))).toThrow("unsafe_policy_regex");
    expect(() => setAndSendSupervisionPolicy(policy({
      app_time_limits: [{ app_regex: "(a+)+", limit_minutes: 10 }],
    }))).toThrow("unsafe_policy_regex");
    expect(getSummarySettings().supervision_policy_updated_at).toBe(before);
  });

  test("expected_policy_updated_at rejects a write based on a stale read", () => {
    const current = getSummarySettings().supervision_policy_updated_at!;
    setAndSendSupervisionPolicy(policy({ expected_policy_updated_at: current, strategy_reason: "fresh read" }));
    expect(getSummarySettings().supervision_policy_reason).toBe("fresh read");

    expect(() => setAndSendSupervisionPolicy(policy({
      expected_policy_updated_at: current,
      strategy_reason: "stale read",
    }))).toThrow("policy_conflict");
    expect(getSummarySettings().supervision_policy_reason).toBe("fresh read");
  });

  test("a controller policy write does not make the phone's next edit look stale", () => {
    expect(updateSummarySettings({ target: "first", client_updated_at: "2026-01-01T00:00:00.000Z" }).sync_status)
      .toBe("applied");
    setAndSendSupervisionPolicy(policy());
    const edit = updateSummarySettings({ target: "second", client_updated_at: "2026-01-01T00:00:01.000Z" });
    expect(edit.sync_status).toBe("applied");
    expect(getSummarySettings().target).toBe("second");
  });

  test("a Live AI refresh after handback keeps the previous controller's hard limits", async () => {
    saveSummarySettings({ ...getSummarySettings(), supervision_enabled: true });
    setAndSendSupervisionPolicy(policy({
      web_allowlist: { allowed_domains: ["example.com"], active_windows: [] },
    }));
    rulesReply({
      whitelist_app_regex: ["com\\.example\\.notes"],
      blacklist_app_regex: ["com\\.example\\.shorts"],
      risk_app_regex: ["com\\.example\\.casino"],
      target_app_regex: ["com\\.example\\.ide"],
      reason: "Live AI rules after handback",
    });

    const result = await refreshSupervisionRules();

    expect(result.supervision_rules_error).toBeNull();
    expect(result.supervision_policy_owner).toBe("hermes");
    expect(result.supervision_check_interval_minutes).toBe(30);
    expect(result.supervision_risk_trigger_minutes).toBe(4);
    expect(result.supervision_app_time_limits).toHaveLength(1);
    expect(result.supervision_web_allowlist.allowed_domains).toEqual(["example.com"]);
    expect(result.supervision_rules.risk_app_regex).toEqual(["com\\.example\\.game"]);
    expect(result.supervision_rules.blacklist_app_regex).toEqual(["com\\.example\\.shorts"]);
  });

  test("a settings save made while the model is answering survives the refresh", async () => {
    saveSummarySettings({ ...getSummarySettings(), supervision_enabled: true, supervision_policy_owner: "live_ai" });
    rulesReply({
      whitelist_app_regex: [],
      blacklist_app_regex: ["com\\.example\\.shorts"],
      risk_app_regex: [],
      target_app_regex: [],
      reason: "Live AI rules",
    }, () => {
      updateSummarySettings({ target: "edited during refresh", client_updated_at: "2027-01-01T00:00:00.000Z" });
    });

    const result = await refreshSupervisionRules();

    expect(result.target).toBe("edited during refresh");
    expect(getSummarySettings().target).toBe("edited during refresh");
    expect(result.supervision_policy_owner).toBe("live_ai");
    expect(result.supervision_app_time_limits).toEqual([]);
  });
});
