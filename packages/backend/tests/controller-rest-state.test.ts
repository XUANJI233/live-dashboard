import { describe, expect, test } from "bun:test";
import { controllerRestState, type DeviceContext } from "../src/services/device-context";

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
    installed_apps_count: 0,
    installed_apps_updated_at: "",
    sleeping: input.sleeping ?? false,
    device_kind: input.device_kind ?? "phone",
    web_allowlist: null,
  };
}
