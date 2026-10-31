import { describe, expect, test } from "bun:test";
import { resolveAppName, resolveHostAppName } from "../src/services/app-mapper";

describe("app names", () => {
  test("a Java host process is named by its window title, not as Minecraft", () => {
    expect(resolveHostAppName("javaw.exe", "Minecraft* 1.21.4")).toBe("Minecraft");
    expect(resolveHostAppName("javaw.exe", "JQuake 1.8.5")).toBe("JQuake");
    expect(resolveHostAppName("javaw.exe", "notes.txt - SomeTool v2.3")).toBe("SomeTool");
    expect(resolveHostAppName("javaw.exe", "")).toBe("Java 应用");
    expect(resolveHostAppName("chrome.exe", "Minecraft wiki")).toBeUndefined();
    expect(resolveAppName("javaw.exe", "windows")).toBe("javaw");
  });

  test("upstream corrections and additions resolve", () => {
    expect(resolveAppName("com.tencent.karaoke", "android")).toBe("全民K歌");
    expect(resolveAppName("Weixin.exe", "windows")).toBe("微信");
  });
});
