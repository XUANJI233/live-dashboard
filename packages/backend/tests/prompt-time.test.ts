import { describe, expect, test } from "bun:test";
import { formatPromptDateTime, localClockStringForOffset, localDateStringForOffset } from "../src/services/prompt-time";

describe("prompt time formatting", () => {
  test("puts user-local time before ISO time and keeps JavaScript timezone offset semantics", () => {
    const at = new Date("2026-07-03T15:30:05.000Z");
    const formatted = formatPromptDateTime(at, -480);

    expect(formatted.startsWith("本地 2026-07-03 23:30:05（UTC+08:00")).toBe(true);
    expect(formatted).toContain("ISO 2026-07-03T15:30:05.000Z");
    expect(formatted).toContain("timezone_offset_minutes=-480");
    expect(localDateStringForOffset(at, -480)).toBe("2026-07-03");
    expect(localClockStringForOffset(at, -480)).toBe("23:30");
  });
});
