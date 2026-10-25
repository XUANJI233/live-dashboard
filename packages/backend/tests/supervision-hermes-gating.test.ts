import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/supervision-hermes-gating.ts", import.meta.url));

interface GatingResult {
  results: Array<boolean | string>;
  webhook_calls: number;
  other_calls: number;
  events: Array<{ event_id: string; event_type: string; source: string; reason_codes: string[] }>;
}

async function runScenario(name: string): Promise<GatingResult> {
  // A child process isolates the real database module and environment from other suites.
  const child = Bun.spawn([process.execPath, fixture, name], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  return JSON.parse(stdout) as GatingResult;
}

describe("Hermes wake gating", () => {
  test("merges repeated rule matches per device while explicit device requests still wake Hermes", async () => {
    const result = await runScenario("report_cooldown");
    expect(result.results).toEqual([true, true, true, true]);
    expect(result.other_calls).toBe(0);
    // Minute 2.5 merges into the minute-0.5 review; minute 11.5 opens the next window.
    expect(result.events.map((event) => event.reason_codes)).toEqual([
      ["rule_match"],
      ["device_requested"],
      ["rule_match"],
    ]);
    expect(new Set(result.events.map((event) => event.event_id)).size).toBe(3);
    expect(result.webhook_calls).toBe(3);
    for (const event of result.events) {
      expect(event.event_type).toBe("supervision.review_requested");
      expect(event.source).toBe("report");
    }
  });

  test("skips due periodic reviews whose material usage is unchanged, at most twice in a row", async () => {
    const result = await runScenario("unchanged_review");
    expect(result.results).toEqual([
      "hermes_review_requested",
      "usage_unchanged_since_review",
      "usage_unchanged_since_review",
      "hermes_review_requested",
      // The reader app crossed the five-minute floor, so usage changed.
      "hermes_review_requested",
    ]);
    expect(result.other_calls).toBe(0);
    expect(result.webhook_calls).toBe(3);
    expect(result.events).toHaveLength(3);
    for (const event of result.events) {
      expect(event.event_type).toBe("supervision.review_requested");
      expect(event.source).toBe("scheduled");
      expect(event.reason_codes).toContain("scheduled_check");
    }
  });
});
