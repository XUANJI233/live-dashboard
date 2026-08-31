import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-ai-jobs-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
process.env.DEVICE_TOKEN_1 = "ai-job-token:ai-job-device:AI Job Android:android";
process.env.AI_JOB_MAX_CONCURRENCY = "2";
delete process.env.AI_API_URL;
delete process.env.AI_API_KEY;

describe("ai jobs", () => {
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // SQLite handles may still be open at process shutdown.
    }
  });

  test("rejects Live-owned AI work before enqueue while Hermes controls the service", async () => {
    const { getAiJob, submitAiJob } = await import("../src/services/ai-jobs");
    process.env.HERMES_CONTROLLER_ENABLED = "true";
    try {
      for (const kind of ["daily_summary", "weekly_summary", "supervision_rules_refresh", "supervision_check"] as const) {
        let caught: unknown;
        try {
          submitAiJob({
            requestId: `req_hermes_${kind}`,
            kind,
            payload: kind === "weekly_summary"
              ? { week_start: "2026-06-08" }
              : kind === "daily_summary"
                ? { date: "2026-06-11" }
                : {},
            device: testDevice,
            deviceToken: "ai-job-token",
            runner: async () => ({ ok: true }),
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toMatchObject({ code: "AI_JOB_MANAGED_BY_HERMES", status: 409 });
      }

      let configTestRuns = 0;
      const configTest = submitAiJob({
        requestId: "req_hermes_ai_config_test",
        kind: "ai_config_test",
        payload: { endpoint: "fallback-check" },
        device: testDevice,
        deviceToken: "ai-job-token",
        runner: async () => {
          configTestRuns += 1;
          return { ok: true };
        },
      });
      const configTestDone = await waitForJob(configTest.job.request_id, () => getAiJob(configTest.job.request_id));
      expect(configTestDone.status).toBe("succeeded");
      expect(configTestRuns).toBe(1);
    } finally {
      delete process.env.HERMES_CONTROLLER_ENABLED;
    }
  });

  test("attaches duplicate submits by kind and job_key without double-running", async () => {
    const { getAiJob, submitAiJob } = await import("../src/services/ai-jobs");
    let runs = 0;

    const first = submitAiJob({
      requestId: "req_daily_ws",
      kind: "daily_summary",
      payload: { date: "2026-06-11", tz: -480 },
      device: testDevice,
      deviceToken: "ai-job-token",
      runner: async () => {
        runs += 1;
        await Bun.sleep(10);
        return {
          ok: true,
          kind: "daily",
          date: "2026-06-11",
          summary: "done",
        };
      },
    });

    const duplicate = submitAiJob({
      requestId: "req_daily_http_fallback",
      kind: "daily_summary",
      payload: { date: "2026-06-11", tz_offset_minutes: -480 },
      device: testDevice,
      deviceToken: "ai-job-token",
      runner: async () => {
        runs += 100;
        return { ok: true, summary: "should not run" };
      },
    });

    expect(duplicate.attached).toBe(true);
    expect(duplicate.job.request_id).toBe(first.job.request_id);
    const finished = await waitForJob(first.job.request_id, () => getAiJob(first.job.request_id));
    expect(finished.status).toBe("succeeded");
    expect(finished.result?.summary).toBe("done");
    expect(runs).toBe(1);
  });

  test("restarts a failed job for the same job_key on retry", async () => {
    const { getAiJob, submitAiJob } = await import("../src/services/ai-jobs");
    let runs = 0;

    const failed = submitAiJob({
      requestId: "req_retry_daily",
      kind: "daily_summary",
      payload: { date: "2026-06-12", tz: -480 },
      device: testDevice,
      deviceToken: "ai-job-token",
      runner: async () => {
        runs += 1;
        throw Object.assign(new Error("temporary outage"), { code: "AI_TEMPORARY_OUTAGE" });
      },
    });
    const firstDone = await waitForJob(failed.job.request_id, () => getAiJob(failed.job.request_id));
    expect(firstDone.status).toBe("failed");

    const retry = submitAiJob({
      requestId: "req_retry_daily_second",
      kind: "daily_summary",
      payload: { date: "2026-06-12", tz: -480 },
      device: testDevice,
      deviceToken: "ai-job-token",
      runner: async () => {
        runs += 1;
        return {
          ok: true,
          kind: "daily",
          date: "2026-06-12",
          summary: "retry succeeded",
        };
      },
    });

    expect(retry.attached).toBe(true);
    expect(retry.job.request_id).toBe(failed.job.request_id);
    const retryDone = await waitForJob(retry.job.request_id, () => getAiJob(retry.job.request_id));
    expect(retryDone.status).toBe("succeeded");
    expect(retryDone.result?.summary).toBe("retry succeeded");
    expect(runs).toBe(2);
  });

  test("exposes quick HTTP submit and poll endpoints", async () => {
    const { handleAiJobQuery, handleAiJobSubmit } = await import("../src/routes/ai-jobs");
    const response = await handleAiJobSubmit(new Request("http://localhost/api/ai-jobs", {
      method: "POST",
      headers: {
        Authorization: "Bearer ai-job-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request_id: "req_http_daily",
        kind: "daily_summary",
        payload: { date: "2026-06-13", tz: -480 },
      }),
    }));
    const body = await response.json() as { job?: { request_id?: string } };
    expect(response.status).toBe(202);
    expect(body.job?.request_id).toBe("req_http_daily");

    const poll = handleAiJobQuery(new Request("http://localhost/api/ai-jobs?request_id=req_http_daily", {
      headers: { Authorization: "Bearer ai-job-token" },
    }), new URL("http://localhost/api/ai-jobs?request_id=req_http_daily"));
    expect(poll.status).toBe(200);
    const pollBody = await poll.json() as { found?: boolean; job?: { request_id?: string } };
    expect(pollBody.found).toBe(true);
    expect(pollBody.job?.request_id).toBe("req_http_daily");
  });

  test("rejects device-submitted supervision checks", async () => {
    const { getAiJob } = await import("../src/services/ai-jobs");
    const { handleAiJobSubmit } = await import("../src/routes/ai-jobs");
    const response = await handleAiJobSubmit(new Request("http://localhost/api/ai-jobs", {
      method: "POST",
      headers: {
        Authorization: "Bearer ai-job-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request_id: "req_device_supervision_forbidden",
        kind: "supervision_check",
        payload: { force: true, at: "2026-06-13T00:00:00.000Z" },
      }),
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "supervision_check jobs can only be started by the MCP control plane",
      code: "AI_JOB_KIND_FORBIDDEN",
    });
    expect(getAiJob("req_device_supervision_forbidden")).toBeNull();
  });

  test("rejects oversized AI job stream bodies without content-length", async () => {
    const { handleAiJobSubmit } = await import("../src/routes/ai-jobs");
    const response = await handleAiJobSubmit(streamingJsonRequest(" ".repeat(129 * 1024)));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Request too large" });
  });

  test("limits concurrent AI job runners", async () => {
    const { getAiJob, submitAiJob } = await import("../src/services/ai-jobs");
    let running = 0;
    let peak = 0;
    const requestIds: string[] = [];

    for (let index = 0; index < 5; index += 1) {
      const submitted = submitAiJob({
        requestId: `req_concurrency_${index}`,
        kind: "daily_summary",
        payload: { date: `2026-07-${String(index + 1).padStart(2, "0")}`, tz: 0 },
        device: testDevice,
        deviceToken: "ai-job-token",
        runner: async () => {
          running += 1;
          peak = Math.max(peak, running);
          await Bun.sleep(40);
          running -= 1;
          return { ok: true, summary: `done ${index}` };
        },
      });
      requestIds.push(submitted.job.request_id);
    }

    await Promise.all(requestIds.map((requestId) => waitForJob(requestId, () => getAiJob(requestId))));
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });
});

const testDevice = {
  device_id: "ai-job-device",
  device_name: "AI Job Android",
  platform: "android" as const,
};

async function waitForJob<T extends { status: string } | null>(
  requestId: string,
  read: () => T,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = read();
    if (job && (job.status === "succeeded" || job.status === "failed")) return job as NonNullable<T>;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${requestId}`);
}

function streamingJsonRequest(body: string): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Request("http://localhost/api/ai-jobs", {
    method: "POST",
    headers: {
      Authorization: "Bearer ai-job-token",
      "Content-Type": "application/json",
    },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}
