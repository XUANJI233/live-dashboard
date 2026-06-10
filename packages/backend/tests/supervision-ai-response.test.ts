import { describe, expect, test } from "bun:test";
import { parseDecisionResponse, parseRulesResponse } from "../src/services/supervision-ai-response";

describe("supervision AI response parsing", () => {
  test("accepts the current device-command decision schema", () => {
    const parsed = parseDecisionResponse(JSON.stringify({
      "设备命令": [{
        device_id: "android-lsp",
        "是否偏离": true,
        "原因": "短视频偏离目标",
        "冻结命令": ["RegExp(\"com\\\\.video\", \"i\")"],
        "解冻命令": [],
        "是否震动": true,
        "是否息屏": false,
        "要说的话": "回到目标。",
      }],
    }));

    expect(parsed.deviated).toBe(true);
    expect(parsed.device_decisions[0]?.device_id).toBe("android-lsp");
    expect(parsed.device_decisions[0]?.freeze_commands).toEqual(["com\\.video"]);
    expect(parsed.device_decisions[0]?.vibrate).toBe(true);
    expect(parsed.device_decisions[0]?.screen_off).toBe(false);
  });

  test("rejects legacy decision aliases", () => {
    expect(() => parseDecisionResponse(JSON.stringify({
      deviceCommands: [{
        deviceId: "android-lsp",
        freezeCommands: ["com.video"],
        vibrate: true,
        screenOff: false,
        message: "legacy",
      }],
    }))).toThrow("设备命令");
  });

  test("normalizes current rule fields without accepting alias fields", () => {
    const parsed = parseRulesResponse(JSON.stringify({
      whitelist_app_regex: ["RegExp(\"Code\", \"i\")"],
      blacklist_app_regex: ["(?i:TikTok)"],
      target_app_regex: ["Docs"],
      reason: "test",
    }));

    expect(parsed.whitelist_app_regex).toEqual(["Code"]);
    expect(parsed.blacklist_app_regex).toEqual(["(?:TikTok)"]);
    expect(parsed.target_app_regex).toEqual(["Docs"]);

    expect(() => parseRulesResponse(JSON.stringify({
      whitelistAppRegex: ["Code"],
      blacklistAppRegex: ["TikTok"],
      targetAppRegex: ["Docs"],
      reason: "legacy",
    }))).toThrow("required regex arrays");
  });
});
