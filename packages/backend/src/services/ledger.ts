import { db } from "../db";
import { safeTimezoneOffset } from "./cdn";
import { getSummarySettings } from "./daily-summary-gen";
import { cleanText } from "./mcp-contracts";
import { formatPromptMinute, localIsoForOffset } from "./prompt-time";
import {
  ledgerFingerprint,
  ledgerLikePattern,
  ledgerSearchText,
  normalizeEvidence,
  rejectPrivateDetail,
  rejectVisitorQuotes,
  type EvidenceInput,
} from "./ledger-guards";
import {
  BREACH_FADE_MS,
  CLOSED_RETENTION_MS,
  DELIVERY_OUTCOMES,
  DUE_RULES,
  HYPOTHESIS_STALE_MS,
  KIND_OUTCOMES,
  LAPSE_AFTER_DUE_MS,
  LEDGER_KINDS,
  LEDGER_SUBTYPES,
  MAX_EVIDENCE_PER_RECORD,
  MAX_OPEN_RECORDS,
  MIN_DUE_LEAD_MS,
  NOTE_OUTCOMES,
  STATE_GRACE_MS,
  TEXT_LIMITS,
  TRACK_WINDOW_MS,
  UNDATED_DEBT_LAPSE_MS,
  type Confidence,
  type LedgerKind,
  type LedgerOutcome,
} from "./ledger-rules";
import {
  countOpenLedgerRecords,
  getLedgerRecord,
  insertLedgerRecord,
  lastBrokenPromise,
  ledgerEvidence,
  openLedgerRecordByFingerprint,
  promiseOutcomeCountsSince,
  recentPromiseOutcomes,
  saveLedgerRecord,
  searchLedgerRows,
  sweepLedgerRecords,
  type EvidenceItem,
  type LedgerFilter,
  type LedgerRow,
} from "./ledger-store";
import { DEFAULT_RECALL_LIMIT, recallLedgerRows } from "./ledger-recall";

// The supervision ledger: promises with a due time, owed tasks and agreed consequences, confirmed
// false claims, working hypotheses and short-lived states, kept in Live so every fresh Hermes run
// and the compressed Weixin session see the same records. Only the controller's MCP calls write
// here, plus Live's own clocks (maintainLedger) and the consequence a broken promise carries.
// Persistence: ledger-store.ts. Limits and clocks: ledger-rules.ts. Hygiene: ledger-guards.ts.

export interface OpenLedgerInput {
  kind: LedgerKind;
  subtype?: string;
  title: string;
  detail?: string;
  evidence: EvidenceInput[];
  due_at?: string;
  due_in_minutes?: number;
  stake?: string;
  confidence?: Confidence;
  parent_id?: string;
}

export interface UpdateLedgerInput {
  record_id: string;
  add_evidence?: EvidenceInput[];
  title?: string;
  detail?: string;
  stake?: string;
  confidence?: Confidence;
  due_at?: string;
  due_in_minutes?: number;
  outcome?: LedgerOutcome;
  note?: string;
}

export interface SearchLedgerInput {
  query?: string;
  about?: string;
  kinds?: LedgerKind[];
  status?: "open" | "closed" | "any";
  outcome?: string;
  from?: string;
  to?: string;
  time_field?: "created" | "due" | "closed";
  include_evidence?: boolean;
  limit?: number;
  cursor?: string;
}

const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/i;
const CONFIDENCE_RANK: Record<string, number> = { "": 0, low: 1, medium: 2, high: 3 };
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 20;
const TRACK_SCAN_LIMIT = 50;
const TIME_FIELDS = { created: "created_at", due: "due_at", closed: "closed_at" } as const;

export function openLedgerRecord(input: OpenLedgerInput, now = new Date()): Record<string, unknown> {
  const kind = input.kind;
  if (!LEDGER_KINDS.includes(kind)) throw new Error("invalid_ledger_field");
  const subtype = checkedSubtype(kind, input.subtype);
  const title = cleanText(input.title, TEXT_LIMITS.title);
  if (!title) throw new Error("invalid_ledger_field");
  const detail = cleanText(input.detail, TEXT_LIMITS.detail);
  if (input.stake !== undefined && kind !== "promise" && kind !== "debt") throw new Error("invalid_ledger_field");
  if (input.confidence !== undefined && kind !== "hypothesis") throw new Error("invalid_ledger_field");
  const stake = cleanText(input.stake, TEXT_LIMITS.stake);
  const evidence = normalizeEvidence(input.evidence, "basis", now);
  if (evidence.length === 0) throw new Error("ledger_evidence_required");
  // A promise is his; a breach is confirmed by something other than what he said.
  if (kind === "promise" && !evidence.some((item) => item.source === "his_words")) {
    throw new Error("ledger_his_words_required");
  }
  if (kind === "breach" && !evidence.some((item) => item.source !== "his_words")) {
    throw new Error("ledger_evidence_required");
  }
  const dueAt = resolveDue(kind, input, now);
  if (dueAt === null && DUE_RULES[kind].use === "required") throw new Error("ledger_due_required");
  rejectPrivateDetail([title, detail, stake, ...evidenceTexts(evidence)]);
  rejectVisitorQuotes(evidence, now);
  const parentId = input.parent_id ?? "";
  if (parentId && !getLedgerRecord(parentId)) throw new Error("ledger_record_not_found");

  const fingerprint = ledgerFingerprint(kind, subtype, evidence[0]!.text);
  return db.transaction(() => {
    // Two runs reading the same words (the Weixin lane and a cron lane) get the first record.
    const same = openLedgerRecordByFingerprint(fingerprint);
    if (same) return { ok: true, record: recordView(same), duplicate: true };
    if (countOpenLedgerRecords(kind) >= MAX_OPEN_RECORDS[kind]) throw new Error("ledger_kind_full");
    const at = now.toISOString();
    const row = insertLedgerRecord({
      record_id: `led_${crypto.randomUUID()}`,
      kind,
      subtype,
      title,
      detail,
      stake,
      confidence: kind === "hypothesis" ? input.confidence ?? "low" : "",
      evidence: JSON.stringify(evidence),
      parent_id: parentId,
      status: "open",
      outcome: "",
      outcome_note: "",
      due_at: dueAt ?? "",
      due_notified_at: "",
      fingerprint,
      search_text: ledgerSearchText([title, detail, stake, subtype], evidence),
      created_at: at,
      updated_at: at,
      closed_at: "",
    });
    return { ok: true, record: recordView(row) };
  })();
}

export function updateLedgerRecord(input: UpdateLedgerInput, now = new Date()): Record<string, unknown> {
  const row = getLedgerRecord(input.record_id);
  if (!row) throw new Error("ledger_record_not_found");
  const changesFields = input.add_evidence !== undefined || input.title !== undefined || input.detail !== undefined
    || input.stake !== undefined || input.confidence !== undefined || input.due_at !== undefined
    || input.due_in_minutes !== undefined;
  if (row.status === "closed") {
    // Closing again the same way (another lane, a retried call) is the same result.
    if (input.outcome === row.outcome && !changesFields) return { ok: true, record: recordView(row), duplicate: true };
    throw new Error("ledger_record_closed");
  }
  if (input.stake !== undefined && row.kind !== "promise" && row.kind !== "debt") throw new Error("invalid_ledger_field");
  if (input.confidence !== undefined && row.kind !== "hypothesis") throw new Error("invalid_ledger_field");
  if (input.note !== undefined && input.outcome === undefined) throw new Error("invalid_ledger_field");

  const next: LedgerRow = { ...row };
  const changes: string[] = [];
  const added = normalizeEvidence(input.add_evidence, input.outcome ? "settlement" : "support", now);
  const affirming = added.filter((item) => item.role !== "counter");
  if (input.title !== undefined) {
    next.title = cleanText(input.title, TEXT_LIMITS.title);
    if (!next.title) throw new Error("invalid_ledger_field");
  }
  if (input.detail !== undefined) next.detail = cleanText(input.detail, TEXT_LIMITS.detail);
  if (input.stake !== undefined) next.stake = cleanText(input.stake, TEXT_LIMITS.stake);
  if (input.confidence !== undefined) {
    // Raising confidence needs a new fact in the same call; lowering it never does.
    if (CONFIDENCE_RANK[input.confidence]! > CONFIDENCE_RANK[row.confidence]! && affirming.length === 0) {
      throw new Error("ledger_evidence_required");
    }
    next.confidence = input.confidence;
  }
  const dueAt = resolveDue(row.kind, input, now);
  if (dueAt !== null) {
    // A promise moves only on his own words, and only before it falls due.
    if (row.kind === "promise") {
      if (row.due_at && Date.parse(row.due_at) <= now.getTime()) throw new Error("ledger_due_passed");
      if (!added.some((item) => item.source === "his_words")) throw new Error("ledger_his_words_required");
    }
    next.due_at = dueAt;
    next.due_notified_at = "";
  }
  if (input.outcome !== undefined) closeRecord(next, input.outcome, cleanText(input.note, TEXT_LIMITS.note), added, now);

  const evidence = [...ledgerEvidence(row)];
  for (const item of added) {
    if (!evidence.some((old) => old.source === item.source && old.text === item.text && old.at === item.at)) evidence.push(item);
  }
  if (evidence.length > MAX_EVIDENCE_PER_RECORD) throw new Error("ledger_evidence_full");
  next.evidence = JSON.stringify(evidence);

  for (const key of ["title", "detail", "stake", "confidence", "due_at", "evidence", "status"] as const) {
    if (next[key] !== row[key]) changes.push(key === "status" ? "outcome" : key);
  }
  if (changes.length === 0) throw new Error("ledger_nothing_to_update");
  rejectPrivateDetail([next.title, next.detail, next.stake, next.outcome_note, ...evidenceTexts(added)]);
  rejectVisitorQuotes(added, now);
  next.search_text = ledgerSearchText([next.title, next.detail, next.stake, next.subtype, next.outcome_note], evidence);
  next.updated_at = now.toISOString();

  return db.transaction(() => {
    const saved = saveLedgerRecord(next);
    const opened = saved.outcome === "broken" && saved.kind === "promise" && saved.stake
      ? openConsequence(saved, now)
      : null;
    return { ok: true, record: recordView(saved), changes, ...(opened ? { opened: [recordView(opened)] } : {}) };
  })();
}

export function searchLedger(input: SearchLedgerInput, now = new Date()): Record<string, unknown> {
  // `about` ranks by relevance (ledger-recall.ts), so it has no pages.
  const recall = input.about !== undefined;
  if (recall && input.cursor !== undefined) throw new Error("invalid_ledger_field");
  const defaultLimit = recall ? DEFAULT_RECALL_LIMIT : DEFAULT_SEARCH_LIMIT;
  const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(input.limit ?? defaultLimit)));
  const query = cleanText(input.query, 40);
  const filter: LedgerFilter = {
    ...(query ? { pattern: ledgerLikePattern(query) } : {}),
    ...(input.kinds?.length ? { kinds: input.kinds } : {}),
    ...(input.status === "open" || input.status === "closed" ? { status: input.status } : {}),
    ...(input.outcome ? { outcome: input.outcome } : {}),
    timeField: TIME_FIELDS[input.time_field ?? "created"],
    ...(input.from ? { from: searchTime(input.from) } : {}),
    ...(input.to ? { to: searchTime(input.to) } : {}),
  };
  const timezoneOffset = settingsOffset();
  const view = (row: LedgerRow) => recordView(row, { includeEvidence: input.include_evidence === true, timezoneOffset });
  if (recall) {
    return {
      generated_at: now.toISOString(),
      records: recallLedgerRows(filter, input.about!, limit).map(view),
      next_cursor: null,
    };
  }
  const rows = searchLedgerRows({
    ...filter,
    ...(input.cursor ? { cursor: decodeCursor(input.cursor) } : {}),
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    generated_at: now.toISOString(),
    records: page.map(view),
    next_cursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
}

/** Kept/broken promises: the current kept streak, the last seven days, and the last broken one. */
export function ledgerTrack(now = new Date(), timezoneOffset = settingsOffset()): Record<string, unknown> {
  let keptStreak = 0;
  for (const row of recentPromiseOutcomes(TRACK_SCAN_LIMIT)) {
    if (row.outcome !== "kept") break;
    keptStreak += 1;
  }
  const counts = promiseOutcomeCountsSince(new Date(now.getTime() - TRACK_WINDOW_MS).toISOString());
  const lastBroken = lastBrokenPromise();
  return {
    kept_streak: keptStreak,
    kept_7d: counts.kept ?? 0,
    broken_7d: counts.broken ?? 0,
    last_broken_local: lastBroken ? formatPromptMinute(lastBroken.closed_at, timezoneOffset) : null,
  };
}

/** Live's own clocks: lapse, end, fade and stale closures, then retention. */
export function maintainLedger(now = new Date()): { closed: number; pruned: number } {
  const before = (ms: number) => new Date(now.getTime() - ms).toISOString();
  return sweepLedgerRecords(now.toISOString(), {
    lapseDueBefore: before(LAPSE_AFTER_DUE_MS),
    lapseUndatedBefore: before(UNDATED_DEBT_LAPSE_MS),
    endStateBefore: before(STATE_GRACE_MS),
    fadeBreachBefore: before(BREACH_FADE_MS),
    staleHypothesisBefore: before(HYPOTHESIS_STALE_MS),
    pruneClosedBefore: before(CLOSED_RETENTION_MS),
  }) as { closed: number; pruned: number };
}

export function recordView(
  row: LedgerRow,
  options: { includeEvidence?: boolean; timezoneOffset?: number } = {},
): Record<string, unknown> {
  const offset = options.timezoneOffset ?? settingsOffset();
  const evidence = ledgerEvidence(row);
  return {
    record_id: row.record_id,
    kind: row.kind,
    ...(row.subtype ? { subtype: row.subtype } : {}),
    title: row.title,
    ...(row.detail ? { detail: row.detail } : {}),
    ...(row.stake ? { stake: row.stake } : {}),
    ...(row.confidence ? { confidence: row.confidence } : {}),
    status: row.status,
    ...(row.outcome ? { outcome: row.outcome } : {}),
    ...(row.outcome_note ? { outcome_note: row.outcome_note } : {}),
    // Machine times carry the local offset too: a model copying the UTC clock with "+08:00" was
    // eight hours off.
    ...(row.due_at ? { due_at: localIsoForOffset(row.due_at, offset), due_local: formatPromptMinute(row.due_at, offset) } : {}),
    ...(row.parent_id ? { parent_id: row.parent_id } : {}),
    created_at: localIsoForOffset(row.created_at, offset),
    created_local: formatPromptMinute(row.created_at, offset),
    ...(row.closed_at ? { closed_at: localIsoForOffset(row.closed_at, offset) } : {}),
    evidence_count: evidence.length,
    ...(options.includeEvidence ? {
      evidence: evidence.map((item) => ({
        role: item.role,
        source: item.source,
        text: item.text,
        at: localIsoForOffset(item.at, offset),
        ...(item.ref ? { ref: item.ref } : {}),
      })),
    } : {}),
  };
}

export function settingsOffset(): number {
  return safeTimezoneOffset(getSummarySettings().timezone_offset_minutes ?? -480);
}

function closeRecord(next: LedgerRow, outcome: LedgerOutcome, note: string, added: EvidenceItem[], now: Date): void {
  if (!KIND_OUTCOMES[next.kind].includes(outcome)) throw new Error("invalid_ledger_outcome");
  const affirming = added.filter((item) => item.role !== "counter");
  const beforeDue = !next.due_at || Date.parse(next.due_at) > now.getTime();
  if (DELIVERY_OUTCOMES.has(outcome) && !affirming.some((item) => item.source !== "his_words")) {
    throw new Error("ledger_evidence_required");
  }
  if ((outcome === "broken" && beforeDue) || outcome === "refuted") {
    if (added.length === 0) throw new Error("ledger_evidence_required");
  }
  if (NOTE_OUTCOMES.has(outcome) && !note) throw new Error("ledger_note_required");
  // Calling off a promise once its time has come is not a cancellation.
  if (outcome === "cancelled" && next.kind === "promise" && !beforeDue) throw new Error("ledger_due_passed");
  const at = now.toISOString();
  next.status = "closed";
  next.outcome = outcome;
  next.outcome_note = note;
  next.closed_at = at;
}

/**
 * The consequence he agreed to in advance becomes a debt, so no later run can forget it. It is not
 * held to the debt cap: dropping an agreed consequence would be worse than one record over.
 */
function openConsequence(promise: LedgerRow, now: Date): LedgerRow | null {
  const at = now.toISOString();
  const evidence: EvidenceItem[] = [{
    role: "basis",
    source: "live_data",
    text: cleanText(`到点未完成：${promise.title}`, TEXT_LIMITS.evidence),
    at,
    ref: promise.record_id,
  }];
  const fingerprint = ledgerFingerprint("debt", "consequence", evidence[0]!.text);
  if (openLedgerRecordByFingerprint(fingerprint)) return null;
  const detail = cleanText(promise.stake, TEXT_LIMITS.detail);
  const title = cleanText(promise.stake, TEXT_LIMITS.title);
  return insertLedgerRecord({
    record_id: `led_${crypto.randomUUID()}`,
    kind: "debt",
    subtype: "consequence",
    title,
    detail,
    stake: "",
    confidence: "",
    evidence: JSON.stringify(evidence),
    parent_id: promise.record_id,
    status: "open",
    outcome: "",
    outcome_note: "",
    due_at: "",
    due_notified_at: "",
    fingerprint,
    search_text: ledgerSearchText([title, detail, "consequence"], evidence),
    created_at: at,
    updated_at: at,
    closed_at: "",
  });
}

function checkedSubtype(kind: LedgerKind, value: string | undefined): string {
  const allowed = LEDGER_SUBTYPES[kind];
  if (allowed.length === 0) {
    if (value !== undefined) throw new Error("invalid_ledger_subtype");
    return "";
  }
  if (value === undefined || !allowed.includes(value)) throw new Error("invalid_ledger_subtype");
  return value;
}

/** The due time a call asks for, as UTC ISO; null when it asks for none. */
function resolveDue(
  kind: LedgerKind,
  input: { due_at?: string; due_in_minutes?: number },
  now: Date,
): string | null {
  const hasAt = input.due_at !== undefined;
  const hasMinutes = input.due_in_minutes !== undefined;
  if (!hasAt && !hasMinutes) return null;
  const rule = DUE_RULES[kind];
  if (rule.use === "none" || (hasAt && hasMinutes)) throw new Error("invalid_ledger_due");
  const ms = hasMinutes
    ? now.getTime() + Math.trunc(Number(input.due_in_minutes)) * 60_000
    : EXPLICIT_OFFSET.test(input.due_at!) ? Date.parse(input.due_at!) : Number.NaN;
  if (!Number.isFinite(ms) || ms < now.getTime() + MIN_DUE_LEAD_MS || ms > now.getTime() + rule.maxMs) {
    throw new Error("invalid_ledger_due");
  }
  return new Date(ms).toISOString();
}

function evidenceTexts(evidence: EvidenceItem[]): string[] {
  return evidence.flatMap((item) => [item.text, item.ref ?? ""]);
}

function searchTime(value: string): string {
  const ms = EXPLICIT_OFFSET.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) throw new Error("invalid_ledger_field");
  return new Date(ms).toISOString();
}

function encodeCursor(row: LedgerRow): string {
  return Buffer.from(JSON.stringify([row.created_at, row.record_id])).toString("base64url");
}

function decodeCursor(value: string): { created_at: string; record_id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf-8")) as unknown;
    if (
      Array.isArray(parsed) && parsed.length === 2
      && typeof parsed[0] === "string" && Number.isFinite(Date.parse(parsed[0]))
      && typeof parsed[1] === "string" && /^led_[0-9a-f-]{36}$/.test(parsed[1])
    ) {
      return { created_at: parsed[0], record_id: parsed[1] };
    }
  } catch {
    // Falls through to the stable error code.
  }
  throw new Error("invalid_cursor");
}
