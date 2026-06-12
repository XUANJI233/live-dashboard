import { describe, expect, test } from "bun:test";
import { getPrivacyTier, processDisplayTitle } from "../src/services/privacy-tiers";

describe("privacy-tiers", () => {
  describe("getPrivacyTier", () => {
    test("YouTube is show tier", () => {
      expect(getPrivacyTier("youtube")).toBe("show");
      expect(getPrivacyTier("YouTube")).toBe("show");
    });

    test("bilibili is show tier", () => {
      expect(getPrivacyTier("哔哩哔哩")).toBe("show");
      expect(getPrivacyTier("bilibili")).toBe("show");
    });

    test("music apps are show tier", () => {
      expect(getPrivacyTier("Spotify")).toBe("show");
      expect(getPrivacyTier("网易云音乐")).toBe("show");
    });

    test("games are show tier by default", () => {
      expect(getPrivacyTier("Steam")).toBe("show");
    });

    test("chat apps are hide tier", () => {
      expect(getPrivacyTier("Discord")).toBe("hide");
      expect(getPrivacyTier("微信")).toBe("hide");
      expect(getPrivacyTier("WeChat")).toBe("hide");
      expect(getPrivacyTier("Telegram")).toBe("hide");
      expect(getPrivacyTier("QQ")).toBe("hide");
    });

    test("AI assistants are hide tier", () => {
      expect(getPrivacyTier("ChatGPT")).toBe("hide");
      expect(getPrivacyTier("Claude")).toBe("hide");
    });

    test("desktop browsers are browser tier", () => {
      expect(getPrivacyTier("Google Chrome")).toBe("browser");
      expect(getPrivacyTier("Microsoft Edge")).toBe("browser");
    });

    test("unknown app defaults to show", () => {
      expect(getPrivacyTier("MyRandomGame")).toBe("show");
    });

    test("empty app is hide tier", () => {
      expect(getPrivacyTier("")).toBe("hide");
    });
  });

  describe("processDisplayTitle", () => {
    test("returns empty for hide tier apps", () => {
      expect(processDisplayTitle("微信", "聊天窗口")).toBe("");
    });

    test("returns window title for show tier apps", () => {
      expect(processDisplayTitle("YouTube", "Video")).toBe("Video");
    });

    test("strips browser suffix", () => {
      // Browser-tier apps get suffix stripped; others keep original
      // com.android.chrome is "show" by default (not in browser tier map)
      const result = processDisplayTitle("com.android.chrome", "Google");
      expect(result).toBe("Google");
    });

    test("hides sensitive browser page titles", () => {
      expect(processDisplayTitle("Google Chrome", "Inbox - Google Chrome")).toBe("");
    });
  });
});
