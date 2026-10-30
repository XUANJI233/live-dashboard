import { afterAll, afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-controller-memory-consumer-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
process.env.MCP_SERVER_TOKEN = "memory-consumer-mcp-token";

const { db, upsertDailySummary } = await import("../src/db");
const { getControllerMemoryFeed } = await import("../src/services/controller-memory");
const { getControllerMemoryFeedForConsumer } = await import("../src/services/controller-memory-consumer");

const insertMessage = db.prepare(`
  INSERT INTO visitor_messages (id, device_id, viewer_id, viewer_name, kind, direction, text, created_at)
  VALUES (?, 'phone', 'friend', 'Friend', 'private', 'viewer', ?, ?)
`);
const MESSAGES_ONLY = { event_types: ["visitor_message"] };

function message(id: string, at: number): void {
  insertMessage.run(id, `text ${id}`, new Date(at).toISOString());
}

function ids(feed: Record<string, unknown>): string[] {
  return ((feed.events ?? []) as Array<{ event_id: string }>).map((event) => event.event_id.replace("visitor_message:", ""));
}

describe("controller memory feed consumer cursor", () => {
  afterEach(() => setSystemTime());
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite file locked until the process exits.
    }
  });

  test("keeps each consumer's position in Live and continues from it", () => {
    const now = Date.parse("2026-10-30T12:00:00.000Z");
    setSystemTime(new Date(now));
    message("m1", now - 60_000);
    message("m2", now - 50_000);
    message("m3", now - 40_000);
    const read = (input: Record<string, unknown> = {}) => getControllerMemoryFeedForConsumer({
      consumer_id: "hermes-memory",
      ...MESSAGES_ONLY,
      ...input,
    });

    const first = read({ since: new Date(now - 120_000).toISOString(), limit: 2, advance: true });
    expect(ids(first)).toEqual(["m1", "m2"]);
    expect(first.has_more).toBe(true);
    expect(first.consumer).toMatchObject({ consumer_id: "hermes-memory", start: "since", previous_cursor: null, advanced: true });

    // A read without advance is a peek: the stored position does not move.
    expect(ids(read({ limit: 2 }))).toEqual(["m3"]);
    const second = read({ limit: 2, advance: true });
    expect(ids(second)).toEqual(["m3"]);
    expect(second.has_more).toBe(false);
    expect(second.consumer).toMatchObject({ start: "stored", previous_cursor: (first.consumer as { cursor: string }).cursor });

    const idle = read({ advance: true });
    expect(ids(idle)).toEqual([]);
    expect(idle.consumer).toMatchObject({ advanced: false, cursor: (second.consumer as { cursor: string }).cursor });

    // Another consumer has its own position and starts from the newest events.
    const other = getControllerMemoryFeedForConsumer({ consumer_id: "audit", ...MESSAGES_ONLY, limit: 1, advance: true });
    expect(ids(other)).toEqual(["m3"]);
    expect(other).toMatchObject({ has_more: false, consumer: { start: "newest", advanced: true } });

    // Replaying from the previous position re-delivers that batch.
    const replay = read({ cursor: (second.consumer as { previous_cursor: string }).previous_cursor });
    expect(ids(replay)).toEqual(["m3"]);
  });

  test("holds back events younger than the settle window until a later call", () => {
    const now = Date.parse("2026-10-30T13:00:00.000Z");
    const read = () => getControllerMemoryFeedForConsumer({ consumer_id: "settle", ...MESSAGES_ONLY, advance: true });
    setSystemTime(new Date(now));
    message("settled", now - 30_000);
    const first = getControllerMemoryFeedForConsumer({
      consumer_id: "settle",
      ...MESSAGES_ONLY,
      since: new Date(now - 60_000).toISOString(),
      advance: true,
    });
    expect(ids(first)).toEqual(["settled"]);
    message("fresh", now - 1_000);

    expect(ids(read())).toEqual([]);
    setSystemTime(new Date(now + 10_000));
    expect(ids(read())).toEqual(["fresh"]);
  });

  test("rejects advancing without a consumer and unreadable cursors", () => {
    expect(() => getControllerMemoryFeedForConsumer({ advance: true })).toThrow("consumer_id_required");
    expect(() => getControllerMemoryFeedForConsumer({ consumer_id: "Bad Id" })).toThrow("invalid_consumer_id");
    expect(() => getControllerMemoryFeedForConsumer({ consumer_id: "hermes-memory", cursor: "garbage" }))
      .toThrow("invalid_memory_cursor");
    expect(() => getControllerMemoryFeed({ until: "not a time" })).toThrow("invalid_memory_until");
  });

  test("filters the plain feed by until and event types", () => {
    message("old", Date.parse("2026-10-01T00:00:00.000Z"));
    message("later", Date.parse("2026-10-02T00:00:00.000Z"));
    upsertDailySummary.run("2026-10-01", "日总结", "normal", "");

    const bounded = getControllerMemoryFeed({
      ...MESSAGES_ONLY,
      since: "2026-09-30T00:00:00.000Z",
      until: "2026-10-01T12:00:00.000Z",
    });
    expect(ids(bounded)).toEqual(["old"]);
    expect(bounded).toMatchObject({ until: "2026-10-01T12:00:00.000Z", has_more: false });
    const summaries = getControllerMemoryFeed({ event_types: ["daily_summary"] });
    expect((summaries.events as Array<{ event_type: string }>).map((event) => event.event_type)).toEqual(["daily_summary"]);
  });

  test("passes the consumer fields through MCP", async () => {
    const { handleMcpRequest } = await import("../src/routes/mcp");
    const call = async (args: Record<string, unknown>) => {
      const response = await handleMcpRequest(new Request("http://127.0.0.1/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          Authorization: "Bearer memory-consumer-mcp-token",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "live_dashboard.get_controller_memory_feed", arguments: args },
        }),
      }), { remoteAddress: "127.0.0.1", localListener: true });
      return ((await response.json()) as { result?: { structuredContent?: Record<string, unknown> } }).result?.structuredContent;
    };

    const first = await call({ consumer_id: "mcp-memory", advance: true, event_types: ["visitor_message"], limit: 2 });
    expect(first?.consumer).toMatchObject({ consumer_id: "mcp-memory", start: "newest", advanced: true });
    const next = await call({ consumer_id: "mcp-memory", advance: true, event_types: ["visitor_message"] });
    expect(next?.consumer).toMatchObject({ start: "stored", previous_cursor: (first?.consumer as { cursor: string }).cursor });
    expect(next?.events).toEqual([]);
  });
});
