import { describe, expect, test } from "vitest";

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
});
