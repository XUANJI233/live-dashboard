import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-review-gate-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

const at = (minutes: number) => new Date(Date.parse("2026-09-07T14:00:00.000Z") + minutes * 60_000);

describe("scheduled review gate", () => {
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // The shared Bun test process may keep SQLite handles open briefly.
    }
  });

  test("skips at most two unchanged rounds in a row, then reviews again", async () => {
    const { nextScheduledReviewState } = await import("../src/services/supervision-review-gate");
    const first = nextScheduledReviewState(null, "same", at(0));
    expect(first).toEqual({ skip: false, state: { signature: "same", reviewed_at: at(0).toISOString(), skipped_rounds: 0 } });

    const second = nextScheduledReviewState(first.state, "same", at(30));
    const third = nextScheduledReviewState(second.state, "same", at(60));
    const fourth = nextScheduledReviewState(third.state, "same", at(90));
    expect([second.skip, third.skip, fourth.skip]).toEqual([true, true, false]);
    expect(third.state).toEqual({ signature: "same", reviewed_at: at(0).toISOString(), skipped_rounds: 2 });
    expect(fourth.state).toEqual({ signature: "same", reviewed_at: at(90).toISOString(), skipped_rounds: 0 });
  });

  test("reviews when usage changed or the last review is four hours old", async () => {
    const { nextScheduledReviewState } = await import("../src/services/supervision-review-gate");
    const reviewed = { signature: "before", reviewed_at: at(0).toISOString(), skipped_rounds: 0 };
    expect(nextScheduledReviewState(reviewed, "after", at(30)).skip).toBe(false);
    expect(nextScheduledReviewState(reviewed, "before", at(239)).skip).toBe(true);
    expect(nextScheduledReviewState(reviewed, "before", at(240)).skip).toBe(false);
  });

  test("persists the review state and ignores malformed records", async () => {
    const { db, metaSet } = await import("../src/db");
    const { readScheduledReviewState, writeScheduledReviewState } = await import("../src/services/supervision-review-gate");
    try {
      const state = { signature: "persisted", reviewed_at: at(0).toISOString(), skipped_rounds: 1 };
      writeScheduledReviewState(state);
      expect(readScheduledReviewState()).toEqual(state);
      metaSet("supervision_last_scheduled_review_usage", "{not json");
      expect(readScheduledReviewState()).toBeNull();
      metaSet("supervision_last_scheduled_review_usage", JSON.stringify({ signature: "x", reviewed_at: "never" }));
      expect(readScheduledReviewState()).toBeNull();
    } finally {
      db.prepare("DELETE FROM meta WHERE key = ?").run("supervision_last_scheduled_review_usage");
    }
  });
});
