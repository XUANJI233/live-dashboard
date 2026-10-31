import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openLedgerRecord, searchLedger, updateLedgerRecord } from "./ledger";
import { LedgerOpenSchema, LedgerSearchSchema, LedgerUpdateSchema } from "./mcp-ledger-schemas";
import { stableToolResult } from "./mcp-tool-result";

// The supervision ledger: what he promised, what he owes, what was proved false, what helps or
// blocks him, and short states, kept in Live so every fresh run sees the same records.
export function registerLedgerTools(server: McpServer): void {
  server.registerTool("live_dashboard.ledger_open", {
    title: "Open a ledger record",
    description: "Record one item every later run must see. promise: his actual one-off promise, with his_words and a due time. debt/task: owed work or a controller-assigned task within delegated goals, supported by the real goal/record, never invented as his promise; debt/consequence: an agreed consequence. breach: a verified false claim or bypass, with his_submission or live_data. hypothesis/helps|blocks: an evidence-backed interpretation with confidence; keep counterevidence and the next test in detail, not a diagnosis. state/observation|streak|other: a temporary state with its end time. Evidence uses his words, a checked submission or a Live record; at may be omitted for now, otherwise give the actual event time with an offset. Never visitor/public messages, memory-feed content, your own words or inference alone; never health, medication or third-party private details, and never reword rejected data to bypass a guard. The same record returns duplicate:true. This does not freeze apps or create device authority. get_controller_context already carries due/open records. Errors: ledger_due_required, invalid_ledger_due, invalid_ledger_subtype, invalid_ledger_field, ledger_his_words_required, ledger_evidence_required, ledger_evidence_time_invalid, quote_not_his_words, health_detail_rejected, private_detail_rejected, ledger_kind_full.",
    inputSchema: LedgerOpenSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(() => openLedgerRecord(args)));

  server.registerTool("live_dashboard.ledger_update", {
    title: "Update or close a ledger record",
    description: "Add evidence, change fields or the due time, or close a record with an outcome. kept and paid need his_submission or live_data; broken before the due time and refuted need evidence; cancelled, waived and forgiven need a note saying where it came from. A promise's due time moves only with his_words and only before it falls due. Raising confidence needs new evidence. A broken promise with a stake opens its consequence as a debt (returned in opened). Closing again with the same outcome returns duplicate: true. Errors: ledger_record_not_found, ledger_record_closed, invalid_ledger_outcome, ledger_evidence_required, ledger_note_required, ledger_due_passed, ledger_evidence_full, ledger_nothing_to_update.",
    inputSchema: LedgerUpdateSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => stableToolResult(() => updateLedgerRecord(args)));

  server.registerTool("live_dashboard.ledger_search", {
    title: "Search the ledger",
    description: "Find ledger records, newest first, by keyword, kinds, status, outcome and a time range; page with next_cursor. With about (free text such as his message) it instead returns the few records most related to that text, open ones first, or none. get_controller_context already carries what is due and open.",
    inputSchema: LedgerSearchSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(() => searchLedger(args)));
}
