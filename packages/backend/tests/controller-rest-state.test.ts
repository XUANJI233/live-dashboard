import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceContext } from "../src/services/device-context";

const tempDir = mkdtempSync(join(tmpdir(), "live-controller-rest-state-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

const { controllerRestState } = await import("../src/services/device-context");

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked until the process exits.
  }
});

describe("controller rest state", () => {
  test("uses one authoritative sleep and screen-off classification", () => {
    expect(controllerRestState([device({ device_kind: "watch", platform: "zepp" })], true)).toBe("asleep");
    expect(controllerRestState([device({ sleeping: true, app_id: "sleeping" })], false)).toBe("screen_off");
    expect(controllerRestState([device({ app_id: "idle" })], false)).toBe("screen_off");
    expect(controllerRestState([device({ app_id: "com.reader" })])).toBe("active");
    expect(controllerRestState([])).toBe("unknown");
  });
});

function device(input: {
  sleeping?: boolean;
  device_kind?: string;
  platform?: string;
  app_id?: string;
}): DeviceContext {
  return {
    device_id: "test-device",
    device_name: "Test Device",
    platform: input.platform ?? "android",
    is_online: true,
    last_seen_at: "2026-09-02T00:00:00.000Z",
    first_seen_at: "2026-09-01T00:00:00.000Z",
    current_app: {
      app_id: input.app_id ?? "idle",
      app_name: "",
      display_title: "",
    },
    capability: {
      schema: "live_dashboard.device_capabilities.v1",
      profile: "android_lsp",
      source: "test",
      capabilities: {
        freeze: true,
        unfreeze: true,
        vibrate: true,
        screen_off: true,
        screenshot: true,
        say: true,
        risk_app_monitor: true,
        app_time_limit: true,
        web_allowlist: true,
      },
    },
    frozen_packages: [],
    frozen_packages_total: null,
    installed_apps_count: 0,
    installed_apps_updated_at: "",
    sleeping: input.sleeping ?? false,
    device_kind: input.device_kind ?? "phone",
    web_allowlist: null,
  };
}
