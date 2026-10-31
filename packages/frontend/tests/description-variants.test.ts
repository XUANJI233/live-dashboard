import { describe, expect, it } from "vitest";
import { mergeUpstreamTexts, pickVariant } from "../src/lib/description-variants";

describe("description variants", () => {
  it("keeps one text per app for half an hour", () => {
    const texts = ["a", "b", "c"];
    const start = 1_793_400_000_000 - (1_793_400_000_000 % (30 * 60 * 1000));
    const first = pickVariant("拼多多", texts, start);
    expect(pickVariant("拼多多", texts, start + 29 * 60 * 1000)).toBe(first);
    const picks = new Set(Array.from({ length: 12 }, (_, i) => pickVariant("拼多多", texts, start + i * 30 * 60 * 1000)));
    expect(picks.size).toBeGreaterThan(1);
    expect(pickVariant("x", "only")).toBe("only");
    expect(pickVariant("x", [])).toBeUndefined();
  });

  it("adds missing apps, widens ours into variants, never replaces ours with one text", () => {
    const ours: Record<string, string | string[]> = { 拼多多: "ours", qq: "ours qq" };
    mergeUpstreamTexts(ours, { 拼多多: ["up 1", "ours"], QQ: "upstream qq", 新应用: ["n1", "n2"] });
    expect(ours).toEqual({ 拼多多: ["ours", "up 1"], qq: "ours qq", 新应用: ["n1", "n2"] });
  });
});
