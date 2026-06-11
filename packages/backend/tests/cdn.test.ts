import { describe, expect, test } from "bun:test";
import { currentHourWindow, withCdnHeaders } from "../src/services/cdn";

describe("cdn", () => {
  test("currentHourWindow returns 10-char UTC hour", () => {
    const date = new Date("2026-06-05T12:34:56.789Z");
    const result = currentHourWindow(date);
    expect(result).toBe("2026060512");
    expect(result.length).toBe(10);
  });

  test("currentHourWindow pads single-digit values", () => {
    const date = new Date("2026-01-01T01:02:03.000Z");
    const result = currentHourWindow(date);
    expect(result).toBe("2026010101");
  });

  test("currentHourWindow midnight is correct", () => {
    const date = new Date("2026-12-31T00:00:00.000Z");
    const result = currentHourWindow(date);
    expect(result).toBe("2026123100");
  });

  test("currentHourWindow defaults to now", () => {
    const result = currentHourWindow();
    expect(result).toMatch(/^\d{10}$/);
    expect(result.length).toBe(10);
  });

  test("cache headers always include shared-cache directives and tags", () => {
    const response = withCdnHeaders(new Response("ok"), ["config"], 60);

    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60, s-maxage=60, stale-while-revalidate=30");
    expect(response.headers.get("Cache-Tag")).toBe("config");
    expect(response.headers.get("ESA-Cache-Tag")).toBe("config");
  });
});
