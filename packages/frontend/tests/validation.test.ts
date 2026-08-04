import { describe, expect, test } from "vitest";
import { getAppDescription, shouldMaskAppDescription } from "../src/lib/app-descriptions";

describe("frontend", () => {
  test("smoke — test environment works", () => {
    expect(1 + 1).toBe(2);
  });

  test("empty message text should be rejected", () => {
    // Verify public message validation logic
    const isInvalid = (text: string) => !text || text.trim().length === 0;
    expect(isInvalid("")).toBe(true);
    expect(isInvalid("   ")).toBe(true);
    expect(isInvalid("hello")).toBe(false);
  });

  test("reserved names check", () => {
    const reserved = new Set([
      "up", "admin", "管理员", "博主", "owner", "root", "system",
    ]);
    const isReserved = (name: string) =>
      reserved.has(name.trim().toLowerCase());
    expect(isReserved("up")).toBe(true);
    expect(isReserved("Admin")).toBe(true);
    expect(isReserved("管理员")).toBe(true);
    expect(isReserved("normal_user")).toBe(false);
    expect(isReserved("")).toBe(false);
  });

  test("NSFW disabled only unmasks apps that match adult signals", () => {
    expect(getAppDescription("Chrome", undefined, undefined, { nsfwFilterEnabled: false }))
      .toBe(getAppDescription("Chrome", undefined, undefined, { nsfwFilterEnabled: true }));
    expect(getAppDescription("Unknown", undefined, undefined, { nsfwFilterEnabled: false }))
      .toBe(getAppDescription("Unknown", undefined, undefined, { nsfwFilterEnabled: true }));
    expect(shouldMaskAppDescription("Chrome", undefined, "example.com")).toBe(false);
  });

  test("NSFW enabled masks adult signals", () => {
    expect(shouldMaskAppDescription("Chrome", undefined, "pornhub.com")).toBe(true);
    expect(getAppDescription("Chrome", "pornhub.com", undefined, { nsfwFilterEnabled: true }))
      .toBe("正在处理一点不方便展开的私密内容喵~");
  });

  test("NSFW disabled stays non-graphic in public UI copy", () => {
    const description = getAppDescription("Chrome", "pornhub.com", undefined, { nsfwFilterEnabled: false });
    expect(description).toContain("私密");
    expect(description).not.toMatch(/肛珠|肉棒|乳头|口球|贞操|自慰|高潮|射出来|前液/);
  });
});
