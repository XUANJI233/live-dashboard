import { metaGet, metaSet } from "../db";
import { getControllerMemoryFeed } from "./controller-memory";

// A named reader of the controller memory feed (the Hermes memory-sync job is "hermes-memory")
// keeps its position in Live instead of a state file its isolated run cannot write. Without an
// explicit cursor or since, a read continues after the stored position; advance:true then stores
// the last delivered event. The read and the store run synchronously, so two calls cannot
// interleave. Callers without consumer_id keep the plain since/cursor feed.

const CONSUMER_ID_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const POSITION_KEY_PREFIX = "controller_memory_consumer:";
// Summary times have one-second precision and a write can land just after a read, so events
// younger than this wait for the next call instead of ending up behind a stored position.
const SETTLE_MS = 5_000;

type ConsumerStart = "cursor" | "since" | "stored" | "newest";

interface ConsumerPosition {
  cursor: string;
  advanced_at: string;
}

export function getControllerMemoryFeedForConsumer(input: Record<string, unknown>): Record<string, unknown> {
  const consumerId = consumerIdFrom(input.consumer_id);
  if (input.advance === true && !consumerId) throw new Error("consumer_id_required");
  if (!consumerId) return getControllerMemoryFeed(input);

  const stored = readPosition(consumerId);
  const start: ConsumerStart = hasText(input.cursor) ? "cursor"
    : hasText(input.since) ? "since"
    : stored ? "stored"
    : "newest";
  const now = new Date();
  const feed = getControllerMemoryFeed({
    ...input,
    cursor: start === "stored" ? stored?.cursor : input.cursor,
    until: settledUntil(input.until, now),
  });
  // The plain feed falls back to the newest events on an unreadable cursor; a consumer must not.
  if (start === "cursor" && feed.cursor === null) throw new Error("invalid_memory_cursor");
  const delivered = Array.isArray(feed.events) ? feed.events.length : 0;
  const nextCursor = typeof feed.next_cursor === "string" ? feed.next_cursor : "";
  const advanced = input.advance === true && delivered > 0 && !!nextCursor;
  const position = advanced ? { cursor: nextCursor, advanced_at: now.toISOString() } : stored;
  if (advanced) metaSet(positionKey(consumerId), JSON.stringify(position));

  return {
    ...feed,
    // For a consumer, has_more=true always means more events follow the delivered ones; a first
    // read from the newest events has nothing after it.
    has_more: start === "newest" ? false : feed.has_more,
    consumer: {
      consumer_id: consumerId,
      start,
      previous_cursor: stored?.cursor ?? null,
      cursor: position?.cursor ?? null,
      advanced,
      advanced_at: position?.advanced_at ?? null,
    },
  };
}

function consumerIdFrom(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || !CONSUMER_ID_RE.test(value)) throw new Error("invalid_consumer_id");
  return value;
}

function readPosition(consumerId: string): ConsumerPosition | null {
  try {
    const parsed = JSON.parse(metaGet(positionKey(consumerId)) || "null") as Partial<ConsumerPosition> | null;
    return parsed && typeof parsed.cursor === "string" && parsed.cursor
      ? { cursor: parsed.cursor, advanced_at: String(parsed.advanced_at ?? "") }
      : null;
  } catch {
    return null;
  }
}

/** The caller's `until` when it is earlier than the settle bound; an unreadable one passes through to be rejected. */
function settledUntil(requested: unknown, now: Date): unknown {
  const settled = new Date(now.getTime() - SETTLE_MS).toISOString();
  if (requested === undefined || requested === null || requested === "") return settled;
  const requestedMs = typeof requested === "string" ? Date.parse(requested) : Number.NaN;
  return Number.isFinite(requestedMs) && requestedMs > Date.parse(settled) ? settled : requested;
}

function positionKey(consumerId: string): string {
  return `${POSITION_KEY_PREFIX}${consumerId}`;
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
