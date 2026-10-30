import { createHash } from "node:crypto";
import { db } from "../db";
import { cleanText } from "./mcp-contracts";
import {
  EVIDENCE_FUTURE_SKEW_MS,
  EVIDENCE_MAX_AGE_MS,
  MIN_CHECKED_QUOTE_LENGTH,
  TEXT_LIMITS,
  VISITOR_QUOTE_WINDOW_MS,
  type EvidenceSource,
} from "./ledger-rules";
import type { EvidenceItem, EvidenceRole } from "./ledger-store";

// Input hygiene for the supervision ledger: evidence shape and times, what may never be stored,
// and the fingerprint and search text every write recomputes. The term and pattern lists are
// deliberately short; the persona's own rules are the main defence for names and paraphrases.

export interface EvidenceInput {
  source: EvidenceSource;
  text: string;
  at: string;
  ref?: string;
  counter?: boolean;
}

const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/i;

// His health stays out of the ledger: diagnoses, medication and treatment.
const HEALTH_TERMS = [
  "adhd", "多动症", "注意力缺陷", "抑郁", "焦虑症", "双相", "确诊", "诊断", "处方", "剂量", "副作用",
  "服药", "吃药", "药效", "病情", "就诊", "托莫西汀", "择思达", "哌甲酯", "专注达",
];
// Phone numbers, email addresses, ID-card and bank-card digit runs.
const PRIVATE_PATTERNS = [
  /(?<!\d)1[3-9]\d{9}(?!\d)/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /(?<!\d)\d{17}[\dXx](?![\dXx])/,
  /(?<!\d)\d{16,19}(?!\d)/,
];

// Visitors write to his page; their words must not be stored as his.
const visitorQuoteStmt = db.prepare(`
  SELECT 1 AS found FROM visitor_messages
  WHERE direction = 'viewer' AND julianday(created_at) >= julianday(?) AND instr(text, ?) > 0
  LIMIT 1
`);

export function normalizeEvidence(items: EvidenceInput[] | undefined, role: EvidenceRole, now: Date): EvidenceItem[] {
  return (items ?? []).map((item) => {
    const text = cleanText(item.text, TEXT_LIMITS.evidence);
    if (text.length < 2) throw new Error("ledger_evidence_required");
    const at = Date.parse(item.at);
    if (
      typeof item.at !== "string"
      || !EXPLICIT_OFFSET.test(item.at)
      || !Number.isFinite(at)
      || at > now.getTime() + EVIDENCE_FUTURE_SKEW_MS
      || at < now.getTime() - EVIDENCE_MAX_AGE_MS
    ) {
      throw new Error("ledger_evidence_time_invalid");
    }
    const ref = cleanText(item.ref, TEXT_LIMITS.ref);
    return {
      role: item.counter === true ? "counter" : role,
      source: item.source,
      text,
      at: new Date(at).toISOString(),
      ...(ref ? { ref } : {}),
    };
  });
}

/** Reject health details and private identifiers in any stored text. */
export function rejectPrivateDetail(texts: string[]): void {
  for (const text of texts) {
    if (!text) continue;
    const lower = text.toLowerCase();
    if (HEALTH_TERMS.some((term) => lower.includes(term))) throw new Error("health_detail_rejected");
    if (PRIVATE_PATTERNS.some((pattern) => pattern.test(text))) throw new Error("private_detail_rejected");
  }
}

/** A "his words" quote found inside a recent visitor message is someone else's words. */
export function rejectVisitorQuotes(items: EvidenceItem[], now: Date): void {
  const since = new Date(now.getTime() - VISITOR_QUOTE_WINDOW_MS).toISOString();
  for (const item of items) {
    if (item.source !== "his_words" || item.text.length < MIN_CHECKED_QUOTE_LENGTH) continue;
    if (visitorQuoteStmt.get(since, item.text)) throw new Error("quote_not_his_words");
  }
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Two runs quoting the same words for the same kind of record collide on purpose. */
export function ledgerFingerprint(kind: string, subtype: string, firstEvidence: string): string {
  return createHash("sha256")
    .update(`${kind}|${subtype}|${normalizeSearchText(firstEvidence)}`)
    .digest("hex")
    .slice(0, 32);
}

export function ledgerSearchText(parts: string[], evidence: EvidenceItem[]): string {
  return normalizeSearchText([...parts, ...evidence.map((item) => item.text)].filter(Boolean).join("\n"));
}

/** A LIKE pattern for a substring, with the wildcard characters taken literally. */
export function ledgerLikePattern(query: string): string {
  return `%${normalizeSearchText(query).replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}
