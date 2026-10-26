import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/supervision-periodic.ts", import.meta.url));
const scenarios = [
  {
    name: "due",
    description: "queues one due unmatched-app review, then respects the configured interval",
    reasons: ["hermes_review_requested", "scheduled_check_not_due"],
    eventCount: 1,
  },
  {
    name: "not_due",
    description: "does not review an unmatched app before the configured interval",
    reasons: ["scheduled_check_not_due"],
    eventCount: 0,
  },
  {
    name: "screen_off",
    description: "keeps the longer interval while every phone screen is off",
    reasons: ["scheduled_check_not_due"],
    eventCount: 0,
  },
  {
    name: "screen_off_due",
    description: "reviews after the longer screen-off interval expires",
    reasons: ["hermes_review_requested"],
    eventCount: 1,
  },
  {
    name: "watch_sleeping",
    description: "does not review while a trusted watch reports sleep",
    reasons: ["trusted_watch_sleeping"],
    eventCount: 0,
  },
  {
    name: "no_timeline",
    description: "does not review without timeline evidence",
    reasons: ["no_timeline_segments"],
    eventCount: 0,
  },
  {
    name: "no_devices",
    description: "does not review without a supported controller device",
    reasons: ["no_controller_devices"],
    eventCount: 0,
  },
  {
    name: "disabled",
    description: "does not review when supervision is disabled",
    reasons: ["supervision_disabled"],
    eventCount: 0,
  },
  {
    name: "report_unmatched",
    description: "does not turn ordinary unmatched reports into extra reviews",
    reasons: [],
    eventCount: 0,
  },
  {
    name: "report_matched",
    description: "keeps matched reports eligible between periodic reviews",
    reasons: [],
    eventCount: 1,
  },
  {
    name: "report_explicit",
    description: "keeps explicit device requests eligible between periodic reviews",
    reasons: [],
    eventCount: 1,
  },
];

describe("Hermes periodic supervision integration", () => {
  for (const scenario of scenarios) {
    test(scenario.description, async () => {
      // A child process isolates the real database module and environment from other suites.
      const child = Bun.spawn([process.execPath, fixture, scenario.name], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      const result = JSON.parse(stdout) as {
        reasons: string[];
        event_count: number;
        webhook_calls: number;
        model_calls: number;
        internal_ai_checks: number;
        events: Array<{ event_type: string; source: string; reason_codes: string[] }>;
      };
      expect(result.reasons).toEqual(scenario.reasons);
      expect(result.event_count).toBe(scenario.eventCount);
      expect(result.webhook_calls).toBe(scenario.eventCount);
      expect(result.model_calls).toBe(0);
      expect(result.internal_ai_checks).toBe(0);
      for (const event of result.events) {
        expect(event.event_type).toBe("supervision.review_requested");
        expect(event.source).toBe(scenario.name.startsWith("report_") ? "report" : "scheduled");
        expect(event.reason_codes).toEqual(scenario.name === "report_matched"
          ? ["rule_match"]
          : scenario.name === "report_explicit" ? ["device_requested"] : ["scheduled_check"]);
      }
    });
  }
});
