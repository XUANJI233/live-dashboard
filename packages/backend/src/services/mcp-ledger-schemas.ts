import { z } from "zod";
import {
  CONFIDENCE_LEVELS,
  EVIDENCE_SOURCES,
  LEDGER_KINDS,
  LEDGER_OUTCOMES,
  LEDGER_SUBTYPE_VALUES,
  RECALL_TEXT_LIMIT,
  SYSTEM_OUTCOMES,
  TEXT_LIMITS,
} from "./ledger-rules";

// Input schemas for the supervision-ledger MCP tools (mcp-ledger-tools.ts). Every model call
// carries them, so descriptions stay short.

const OffsetTimeSchema = z.string().max(40).regex(/(?:Z|[+-]\d{2}:\d{2})$/);
const LedgerIdSchema = z.string().regex(/^led_[0-9a-f-]{36}$/);

const EvidenceSchema = z.object({
  source: z.enum(EVIDENCE_SOURCES)
    .describe("his_words: his exact words; his_submission: something he sent that you checked; live_data: a Live record."),
  text: z.string().min(2).max(TEXT_LIMITS.evidence).describe("His words, what he sent, or what the record shows."),
  at: OffsetTimeSchema.describe("When he said or sent it, or when the data happened; Z or +08:00."),
  ref: z.string().min(1).max(TEXT_LIMITS.ref).optional().describe("Optional id: command, bill, ledger record, or device and window."),
});

const UpdateEvidenceSchema = EvidenceSchema.extend({
  counter: z.boolean().optional().describe("true when this contradicts the record."),
});

const DueFields = {
  due_at: OffsetTimeSchema.optional().describe("Due or end time with Z or +08:00; give this or due_in_minutes."),
  due_in_minutes: z.number().int().min(1).max(43_200).optional().describe("Minutes from now."),
};

export const LedgerOpenSchema = z.object({
  kind: z.enum(LEDGER_KINDS),
  subtype: z.enum(LEDGER_SUBTYPE_VALUES).optional()
    .describe("debt: task|consequence; breach: false_claim|bypass; hypothesis: helps|blocks; state: observation|streak|other. None for promise."),
  title: z.string().min(1).max(TEXT_LIMITS.title),
  detail: z.string().max(TEXT_LIMITS.detail).optional(),
  evidence: z.array(EvidenceSchema).min(1).max(4),
  ...DueFields,
  stake: z.string().min(2).max(TEXT_LIMITS.stake).optional().describe("Promise or debt: the consequence he agreed to in advance."),
  confidence: z.enum(CONFIDENCE_LEVELS).optional().describe("Hypothesis only; default low."),
  parent_id: LedgerIdSchema.optional(),
});

export const LedgerUpdateSchema = z.object({
  record_id: LedgerIdSchema,
  add_evidence: z.array(UpdateEvidenceSchema).min(1).max(3).optional(),
  title: z.string().min(1).max(TEXT_LIMITS.title).optional(),
  detail: z.string().max(TEXT_LIMITS.detail).optional(),
  stake: z.string().min(2).max(TEXT_LIMITS.stake).optional(),
  confidence: z.enum(CONFIDENCE_LEVELS).optional(),
  ...DueFields,
  outcome: z.enum(LEDGER_OUTCOMES).optional().describe("Closes the record."),
  note: z.string().min(1).max(TEXT_LIMITS.note).optional().describe("With an outcome: where a cancellation or leniency came from."),
});

export const LedgerSearchSchema = z.object({
  query: z.string().min(1).max(40).optional().describe("Substring of title, detail, stake, note or evidence; Chinese works."),
  about: z.string().min(1).max(RECALL_TEXT_LIMIT).optional()
    .describe("Free text such as his message: only records sharing its distinctive words, open first, best first; no cursor."),
  kinds: z.array(z.enum(LEDGER_KINDS)).min(1).max(5).optional(),
  status: z.enum(["open", "closed", "any"]).optional().describe("Default any."),
  outcome: z.enum([...LEDGER_OUTCOMES, ...SYSTEM_OUTCOMES]).optional(),
  from: OffsetTimeSchema.optional(),
  to: OffsetTimeSchema.optional(),
  time_field: z.enum(["created", "due", "closed"]).optional().describe("Which time from/to filter; default created."),
  include_evidence: z.boolean().optional().describe("Default false."),
  limit: z.number().int().min(1).max(20).optional().describe("Default 10, or 5 with about."),
  cursor: z.string().min(1).max(200).optional().describe("next_cursor from the previous page."),
});
