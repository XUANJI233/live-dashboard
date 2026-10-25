import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-web-allowlist-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

const lspCapabilities = {
  freeze: true,
  unfreeze: true,
  vibrate: true,
  screen_off: false,
  say: true,
  risk_app_monitor: true,
  app_time_limit: true,
};

describe("web allowlist", () => {
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // The shared Bun test process may keep SQLite handles open briefly.
    }
  });

  test("normalizes domains, windows, and reported status", async () => {
    const { cleanWebAllowlistStatus, normalizeWebAllowlistPolicy, normalizeWebDomain } = await import("../src/services/web-allowlist");

    expect(normalizeWebDomain("https://User@Docs.Example.com:8443/path?q=1")).toBe("docs.example.com");
    expect(normalizeWebDomain("*.edu.cn")).toBe("edu.cn");
    expect(normalizeWebDomain(".example.org.")).toBe("example.org");
    for (const rejected of ["localhost", "com", "bad_label.com", "-dash.com", "a".repeat(64) + ".com", 42]) {
      expect(normalizeWebDomain(rejected)).toBe("");
    }

    expect(normalizeWebAllowlistPolicy({
      allowed_domains: ["Example.com", "https://example.com/again", "", "single", "zhihu.com"],
      active_windows: [
        { days: [5, 1, 1, 9], start: "08:30", end: "11:30" },
        { days: [], start: "22:00", end: "01:00" },
        { start: "14:00", end: "14:00" },
        { start: "19:00", end: "21:00" },
      ],
    })).toEqual({
      allowed_domains: ["example.com", "zhihu.com"],
      active_windows: [
        { days: [1, 5], start: "08:30", end: "11:30" },
        { days: [], start: "19:00", end: "21:00" },
      ],
    });
    expect(normalizeWebAllowlistPolicy(null)).toEqual({ allowed_domains: [], active_windows: [] });

    expect(cleanWebAllowlistStatus({
      active: true,
      paused_until: "2026-10-25T10:00:00+08:00",
      browser_package: "com.android.browser",
      allowed_domain_count: 999,
      paused_browsers: ["com.android.chrome", "bad package", "com.microsoft.emmx"],
      last_blocked_host: "www.bilibili.com",
      last_blocked_at: "not a time",
    })).toEqual({
      active: true,
      paused_until: "2026-10-25T02:00:00.000Z",
      browser_package: "com.android.browser",
      allowed_domain_count: 64,
      paused_browsers: ["com.android.chrome", "com.microsoft.emmx"],
      last_blocked_host: "www.bilibili.com",
      last_blocked_at: "",
    });
    expect(cleanWebAllowlistStatus("active")).toBeNull();
  });

  test("syncs the allowlist in the complete policy snapshot and clears it when omitted or supervision is off", async () => {
    const { processReportPayload } = await import("../src/services/device-status-handler");
    const { setAndSendSupervisionPolicy } = await import("../src/services/supervision-policy-control");
    const {
      effectiveSupervisionPolicySnapshot,
      getSummarySettings,
      supervisionPolicySnapshot,
      updateSupervisionPolicy,
    } = await import("../src/services/daily-summary-gen");
    const { getControllerPersona, updateControllerPersona } = await import("../src/services/controller-persona");
    const previousPersona = getControllerPersona();
    const previousPolicy = supervisionPolicySnapshot();
    updateControllerPersona({ enabled: true, controller: "hermes" });
    const device = { device_id: "web-allowlist-phone", device_name: "Web phone", platform: "android" as const };
    try {
      // An LSP build that only enforces the web allowlist still receives the policy.
      processReportPayload({
        app_id: "com.android.browser",
        window_title: "Reading",
        extra: {
          device: {
            profile: "android_lsp",
            capabilities: { ...lspCapabilities, risk_app_monitor: false, app_time_limit: false, web_allowlist: true },
          },
        },
      }, device);
      const webAllowlist = {
        allowed_domains: ["docs.example.com", "https://Zhihu.com/question/1"],
        active_windows: [{ days: [1, 2, 3, 4, 5], start: "08:00", end: "12:00" }],
      };
      const sent = setAndSendSupervisionPolicy({
        policy_owner: "hermes",
        strategy_reason: "Study block: documentation only.",
        review_interval_minutes: 30,
        risk_app_regex: [],
        risk_trigger_minutes: 3,
        app_time_limits: [],
        web_allowlist: webAllowlist,
        device_ids: [device.device_id],
        request_id: "req_web_allowlist",
      });
      const normalized = {
        allowed_domains: ["docs.example.com", "zhihu.com"],
        active_windows: [{ days: [1, 2, 3, 4, 5], start: "08:00", end: "12:00" }],
      };
      expect(sent.policy.web_allowlist).toEqual(normalized);
      expect(sent.commands.map((command) => command.delivery.status)).toEqual(["queued"]);
      expect(sent.commands[0]?.payload.payload).toMatchObject({ kind: "supervision_policy", web_allowlist: normalized });
      expect(getSummarySettings().supervision_web_allowlist).toEqual(normalized);

      expect(effectiveSupervisionPolicySnapshot({ ...getSummarySettings(), supervision_enabled: true }).web_allowlist)
        .toEqual(normalized);
      expect(effectiveSupervisionPolicySnapshot({ ...getSummarySettings(), supervision_enabled: false }).web_allowlist)
        .toEqual({ allowed_domains: [], active_windows: [] });

      const cleared = setAndSendSupervisionPolicy({
        policy_owner: "hermes",
        strategy_reason: "Study block over.",
        review_interval_minutes: 30,
        risk_app_regex: [],
        risk_trigger_minutes: 3,
        app_time_limits: [],
        device_ids: [device.device_id],
        request_id: "req_web_allowlist_cleared",
      });
      expect(cleared.policy.web_allowlist).toEqual({ allowed_domains: [], active_windows: [] });
      expect(cleared.commands[0]?.payload.payload).toMatchObject({
        web_allowlist: { allowed_domains: [], active_windows: [] },
      });
    } finally {
      updateSupervisionPolicy(previousPolicy);
      updateControllerPersona({ enabled: previousPersona.enabled, controller: previousPersona.controller });
    }
  });

  test("keeps reported enforcement status private to controller reads", async () => {
    const { processReportPayload } = await import("../src/services/device-status-handler");
    const { getDeviceContext } = await import("../src/services/device-context");
    const device = { device_id: "web-allowlist-status-phone", device_name: "Status phone", platform: "android" as const };
    const update = processReportPayload({
      app_id: "com.android.browser",
      window_title: "Docs",
      extra: {
        device: {
          profile: "android_lsp",
          capabilities: { ...lspCapabilities, web_allowlist: true },
          web_allowlist: {
            active: true,
            paused_until: "",
            browser_package: "com.android.browser",
            allowed_domain_count: 2,
            paused_browsers: ["com.android.chrome"],
            last_blocked_host: "www.bilibili.com",
            last_blocked_at: "2026-10-25T02:00:00.000Z",
          },
        },
      },
    }, device);

    expect(JSON.stringify(update)).not.toContain("bilibili");
    expect((update?.extra.device as Record<string, unknown>).web_allowlist).toBeUndefined();
    const context = getDeviceContext(device.device_id);
    expect(context?.capability.capabilities.web_allowlist).toBe(true);
    expect(context?.web_allowlist).toMatchObject({
      active: true,
      browser_package: "com.android.browser",
      paused_browsers: ["com.android.chrome"],
      last_blocked_host: "www.bilibili.com",
    });
  });
});
