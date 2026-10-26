import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { completedAiJob } from "../src/services/ai-job-runner";

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

  test("delegates every Live AI request to Hermes without running a Live model", async () => {
    const { claimDelegatedAiJobs, completeDelegatedAiJob, getAiJob, submitAiJob } = await import("../src/services/ai-jobs");
    process.env.HERMES_CONTROLLER_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_URL = "https://controller.example/webhooks/live-supervision";
    process.env.CONTROLLER_WEBHOOK_SECRET = "independent-ai-delegation-secret";
    const originalFetch = globalThis.fetch;
    const events: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const event = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      events.push(event);
      return Response.json({
        status: "accepted",
        ack: {
          schema: "live_dashboard.controller_ack.v1",
          v: 1,
          event_id: event.event_id,
          accepted: true,
        },
      }, { status: 202 });
    }) as typeof fetch;
    try {
      const requests = [
        ["daily_summary", { date: "2026-05-21", tz_offset_minutes: -480 }],
        ["weekly_summary", { week_start: "2026-05-18", tz_offset_minutes: -480 }],
        ["supervision_rules_refresh", { settings_updated_at: "2026-05-21T00:00:00.000Z" }],
        ["supervision_check", { at: "2026-05-21T01:00:00.000Z", source: "report", force: true }],
      ] as const;
      let liveRunnerCalls = 0;
      for (const [kind, payload] of requests) {
        const submitted = submitAiJob({
          requestId: `req_hermes_${kind}`,
          kind,
          payload,
          device: testDevice,
          deviceToken: "ai-job-token",
          runner: async () => {
            liveRunnerCalls += 1;
            return completedAiJob({ ok: true, model_called: true });
          },
        });
        const delegated = await waitForJobStatus(
          submitted.job.request_id,
          () => getAiJob(submitted.job.request_id),
          ["delegated"],
        );
        expect(delegated.result).toMatchObject({
          ok: true,
          delegated: true,
          managed_by: "hermes",
          delivery_status: "accepted",
        });
        const claimedRequests = claimDelegatedAiJobs({ owner_id: "test-controller", limit: 20 }).requests;
        const claimedRequest = claimedRequests
          .find((item) => item.request_id === submitted.job.request_id);
        expect(claimedRequest).toBeDefined();
        expect(claimedRequest!.request_id).toBe(submitted.job.request_id);
        expect(typeof claimedRequest!.claim_token).toBe("string");
        const claimToken = String(claimedRequest!.claim_token);
        expect(claimToken).toMatch(/^claim_[a-f0-9-]{36}$/);
        const done = completeDelegatedAiJob({
          request_id: submitted.job.request_id,
          claim_token: claimToken,
          outcome: "skipped",
          detail: "test completion",
        });
        expect(done.status).toBe("succeeded");
        const repeated = completeDelegatedAiJob({
          request_id: submitted.job.request_id,
          claim_token: claimToken,
          outcome: "failed",
          detail: "must not overwrite the settled outcome",
        });
        expect(repeated.status).toBe("succeeded");
      }
      expect(liveRunnerCalls).toBe(0);
      expect(events).toHaveLength(4);
      expect(events.map((event) => (event.ai_request as { kind?: string }).kind)).toEqual(
        requests.map(([kind]) => kind),
      );
      expect(events[0]).toMatchObject({
        schema: "live_dashboard.controller_event.v1",
        v: 1,
        event_type: "ai.work_requested",
        source: "client",
        device_ids: [testDevice.device_id],
        reason_codes: ["daily_summary"],
        ai_request: {
          request_id: "req_hermes_daily_summary",
          kind: "daily_summary",
          payload: { date: "2026-05-21", tz_offset_minutes: -480 },
        },
      });

      let configTestRuns = 0;
      const configTest = submitAiJob({
        requestId: "req_hermes_ai_config_test",
        kind: "ai_config_test",
        payload: { endpoint: "fallback-check" },
        device: testDevice,
        deviceToken: "ai-job-token",
        runner: async () => {
          configTestRuns += 1;
          return completedAiJob({ ok: true });
        },
      });
      const configTestDone = await waitForJob(configTest.job.request_id, () => getAiJob(configTest.job.request_id));
      expect(configTestDone.status).toBe("succeeded");
      expect(configTestDone.result).toMatchObject({
        ok: true,
        delegated: false,
        managed_by: "hermes",
        provider_test_skipped: true,
      });
      expect(configTestRuns).toBe(0);
      expect(events).toHaveLength(4);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.HERMES_CONTROLLER_ENABLED;
      delete process.env.CONTROLLER_WEBHOOK_ENABLED;
      delete process.env.CONTROLLER_WEBHOOK_URL;
      delete process.env.CONTROLLER_WEBHOOK_SECRET;
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
        return completedAiJob({
          ok: true,
          kind: "daily",
          date: "2026-06-11",
          summary: "done",
        });
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
        return completedAiJob({ ok: true, summary: "should not run" });
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
        return completedAiJob({
          ok: true,
          kind: "daily",
          date: "2026-06-12",
          summary: "retry succeeded",
        });
      },
    });

    expect(retry.attached).toBe(true);
    expect(retry.job.request_id).toBe(failed.job.request_id);
    const retryDone = await waitForJob(retry.job.request_id, () => getAiJob(retry.job.request_id));
    expect(retryDone.status).toBe("succeeded");
    expect(retryDone.result?.summary).toBe("retry succeeded");
    expect(runs).toBe(2);
  });

  test("a failed Live job retry cannot bypass a later Hermes takeover", async () => {
    const { claimDelegatedAiJobs, completeDelegatedAiJob, getAiJob, submitAiJob } = await import("../src/services/ai-jobs");
    let liveRunnerCalls = 0;
    const first = submitAiJob({
      requestId: "req_before_hermes_takeover",
      kind: "daily_summary",
      payload: { date: "2026-04-21", tz_offset_minutes: -480 },
      device: testDevice,
      deviceToken: "ai-job-token",
      runner: async () => {
        liveRunnerCalls += 1;
        throw new Error("pre-takeover failure");
      },
    });
    expect((await waitForJob(first.job.request_id, () => getAiJob(first.job.request_id))).status).toBe("failed");

    const originalFetch = globalThis.fetch;
    process.env.HERMES_CONTROLLER_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_URL = "https://controller.example/webhooks/live-supervision";
    process.env.CONTROLLER_WEBHOOK_SECRET = "independent-retry-takeover-secret";
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const event = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      return Response.json({
        status: "accepted",
        ack: { schema: "live_dashboard.controller_ack.v1", v: 1, event_id: event.event_id, accepted: true },
      }, { status: 202 });
    }) as typeof fetch;
    try {
      const retry = submitAiJob({
        requestId: "req_after_hermes_takeover",
        kind: "daily_summary",
        payload: { date: "2026-04-21", tz_offset_minutes: -480 },
        device: testDevice,
        deviceToken: "ai-job-token",
        runner: async () => {
          liveRunnerCalls += 100;
          return completedAiJob({ ok: true, model_called: true });
        },
      });
      const delegated = await waitForJobStatus(
        retry.job.request_id,
        () => getAiJob(retry.job.request_id),
        ["delegated"],
      );
      expect(delegated.result).toMatchObject({ managed_by: "hermes", delegated: true });
      const claimedRequest = claimDelegatedAiJobs({ owner_id: "takeover-controller", limit: 20 }).requests
        .find((item) => item.request_id === retry.job.request_id);
      expect(claimedRequest).toMatchObject({ request_id: retry.job.request_id });
      const done = completeDelegatedAiJob({
        request_id: retry.job.request_id,
        claim_token: claimedRequest?.claim_token,
        outcome: "skipped",
      });
      expect(done.status).toBe("succeeded");
      expect(liveRunnerCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.HERMES_CONTROLLER_ENABLED;
      delete process.env.CONTROLLER_WEBHOOK_ENABLED;
      delete process.env.CONTROLLER_WEBHOOK_URL;
      delete process.env.CONTROLLER_WEBHOOK_SECRET;
    }
  });

  test("keeps concurrent Hermes requests in one durable delegated batch", async () => {
    const {
      completeDelegatedAiJob,
      claimDelegatedAiJobs,
      getAiJob,
      listDelegatedAiJobs,
      submitAiJob,
    } = await import("../src/services/ai-jobs");
    const originalFetch = globalThis.fetch;
    process.env.HERMES_CONTROLLER_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_URL = "https://controller.example/webhooks/live-supervision";
    process.env.CONTROLLER_WEBHOOK_SECRET = "independent-batch-secret";
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const event = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      return Response.json({
        status: "accepted",
        ack: { schema: "live_dashboard.controller_ack.v1", v: 1, event_id: event.event_id, accepted: true },
      }, { status: 202 });
    }) as typeof fetch;
    const ids: string[] = [];
    try {
      for (const [kind, payload] of [
        ["daily_summary", { date: "2026-03-21", tz_offset_minutes: -480 }],
        ["weekly_summary", { week_start: "2026-03-16", tz_offset_minutes: -480 }],
      ] as const) {
        const submitted = submitAiJob({
          requestId: `req_batch_${kind}`,
          kind,
          payload,
          device: testDevice,
          deviceToken: "ai-job-token",
        });
        ids.push(submitted.job.request_id);
      }
      await Promise.all(ids.map((requestId) => waitForJobStatus(
        requestId,
        () => getAiJob(requestId),
        ["delegated"],
      )));
      expect(listDelegatedAiJobs(20).filter((item) => ids.includes(String(item.request_id)))).toHaveLength(2);
      const claimed = claimDelegatedAiJobs({ owner_id: "batch-controller", limit: 20 });
      expect(claimed.requests.filter((item) => ids.includes(String(item.request_id)))).toHaveLength(2);
      expect(claimDelegatedAiJobs({ owner_id: "concurrent-controller", limit: 20 }).requests
        .filter((item) => ids.includes(String(item.request_id)))).toHaveLength(0);
      for (const requestId of ids) {
        const request = claimed.requests.find((item) => item.request_id === requestId);
        expect(request).toBeDefined();
        expect(() => completeDelegatedAiJob({
          request_id: requestId,
          claim_token: "claim_00000000-0000-0000-0000-000000000000",
          outcome: "skipped",
        })).toThrow(expect.objectContaining({ code: "AI_JOB_CLAIM_MISMATCH" }));
        expect(completeDelegatedAiJob({
          request_id: requestId,
          claim_token: request?.claim_token,
          outcome: "skipped",
        }).status).toBe("succeeded");
      }
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.HERMES_CONTROLLER_ENABLED;
      delete process.env.CONTROLLER_WEBHOOK_ENABLED;
      delete process.env.CONTROLLER_WEBHOOK_URL;
      delete process.env.CONTROLLER_WEBHOOK_SECRET;
    }
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
          return completedAiJob({ ok: true, summary: `done ${index}` });
        },
      });
      requestIds.push(submitted.job.request_id);
    }

    await Promise.all(requestIds.map((requestId) => waitForJob(requestId, () => getAiJob(requestId))));
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });

  test("delegated jobs do not get stranded after a handback to Live AI", async () => {
    const { db } = await import("../src/db");
    const {
      expireUnclaimedDelegatedAiJobs,
      getAiJob,
      recoverInterruptedAiJobs,
      submitAiJob,
    } = await import("../src/services/ai-jobs");
    const { claimServiceAiJobs } = await import("../src/services/mcp-admin");
    const originalFetch = globalThis.fetch;
    process.env.HERMES_CONTROLLER_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_ENABLED = "true";
    process.env.CONTROLLER_WEBHOOK_URL = "https://controller.example/webhooks/live-supervision";
    process.env.CONTROLLER_WEBHOOK_SECRET = "independent-handback-secret";
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const event = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      return Response.json({
        status: "accepted",
        ack: { schema: "live_dashboard.controller_ack.v1", v: 1, event_id: event.event_id, accepted: true },
      }, { status: 202 });
    }) as typeof fetch;
    const delegate = async (date: string) => {
      const submitted = submitAiJob({
        requestId: `req_handback_${date}`,
        kind: "daily_summary",
        payload: { date, tz_offset_minutes: -480 },
        device: testDevice,
        deviceToken: "ai-job-token",
      });
      return waitForJobStatus(submitted.job.request_id, () => getAiJob(submitted.job.request_id), ["delegated"]);
    };
    let restartedRequestId = "";
    let recoveredRequestId = "";
    let expiredRequestId = "";
    try {
      restartedRequestId = (await delegate("2026-05-01")).request_id;
      recoveredRequestId = (await delegate("2026-05-02")).request_id;
      expiredRequestId = (await delegate("2026-05-03")).request_id;
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.HERMES_CONTROLLER_ENABLED;
      delete process.env.CONTROLLER_WEBHOOK_ENABLED;
      delete process.env.CONTROLLER_WEBHOOK_URL;
      delete process.env.CONTROLLER_WEBHOOK_SECRET;
    }

    // Live AI is back: resubmitting the same work restarts the delegated job with a Live runner.
    let liveRuns = 0;
    const resubmitted = submitAiJob({
      requestId: "req_handback_resubmit",
      kind: "daily_summary",
      payload: { date: "2026-05-01", tz_offset_minutes: -480 },
      device: testDevice,
      deviceToken: "ai-job-token",
      runner: async () => {
        liveRuns += 1;
        return completedAiJob({ ok: true, summary: "live after handback" });
      },
    });
    expect(resubmitted.job.request_id).toBe(restartedRequestId);
    expect((await waitForJob(restartedRequestId, () => getAiJob(restartedRequestId))).status).toBe("succeeded");
    expect(liveRuns).toBe(1);

    // A delegation the controller never claimed fails after two hours.
    db.prepare("UPDATE ai_jobs SET updated_at = ? WHERE request_id = ?")
      .run(new Date(Date.now() - 3 * 60 * 60_000).toISOString(), expiredRequestId);
    expect(expireUnclaimedDelegatedAiJobs()).toBe(1);
    expect(getAiJob(expiredRequestId)?.status).toBe("failed");

    // A restart in Live AI mode fails the controller-owned jobs left behind.
    recoverInterruptedAiJobs();
    const recovered = getAiJob(recoveredRequestId);
    expect(recovered?.status).toBe("failed");
    expect(JSON.stringify(recovered?.error)).toContain("AI_JOB_CONTROLLER_INACTIVE");

    expect(() => claimServiceAiJobs({ owner_id: "late-hermes" })).toThrow("hermes_controller_inactive");
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

async function waitForJobStatus<T extends { status: string } | null>(
  requestId: string,
  read: () => T,
  statuses: string[],
): Promise<NonNullable<T>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = read();
    if (job && statuses.includes(job.status)) return job as NonNullable<T>;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${requestId}: ${statuses.join(",")}`);
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
