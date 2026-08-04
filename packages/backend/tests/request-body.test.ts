import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-request-body-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
process.env.DEVICE_TOKEN_1 = "body-token:body-device:Body Device:android";

describe("bounded request body reads", () => {
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // SQLite handles may still be open at process shutdown.
    }
  });

  test("rejects oversized summary settings stream bodies without content-length", async () => {
    const { handleSummarySettingsUpdate } = await import("../src/routes/daily-summary");
    const response = await handleSummarySettingsUpdate(streamingJsonRequest(" ".repeat(129 * 1024), "http://localhost/api/summary-settings"));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Request too large" });
  });

  test("rejects oversized device report stream bodies without content-length", async () => {
    const { handleReport } = await import("../src/routes/report");
    const response = await handleReport(streamingJsonRequest(" ".repeat(1024 * 1024 + 1), "http://localhost/api/report"));

    expect(response.status).toBe(413);
  });

  test("rejects oversized viewer token stream bodies without content-length", async () => {
    const { handleViewerTokenIssue } = await import("../src/routes/viewer-token");
    const response = await handleViewerTokenIssue(streamingJsonRequest(" ".repeat(33 * 1024), "http://localhost/api/token/issue", false), "127.0.0.1");

    expect(response.status).toBe(413);
  });
});

function streamingJsonRequest(body: string, url: string, auth = true): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (auth) headers.Authorization = "Bearer body-token";
  return new Request(url, {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}
