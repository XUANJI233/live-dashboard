import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { commitmentsContext, endCommitment, recordCommitment } from "./commitments";
import { requestExceptionUnfreeze } from "./commitment-tools";
import { EndCommitmentSchema, ExceptionUnfreezeSchema, RecordCommitmentSchema } from "./mcp-tool-schemas";
import { stableToolResult } from "./mcp-tool-result";

// The user's own long-lived rules: record, end, list, and the one time-boxed way to open a
// committed package.
export function registerCommitmentTools(server: McpServer): void {
  server.registerTool("live_dashboard.record_commitment", {
    title: "Record a commitment",
    description: "Persist a rule the user explicitly set, quoting his words. A block rule names exact packages and an optional daily window; Live keeps them frozen inside the window by itself, re-freezing after the phone's nightly cleanup, until the rule ends. A task rule only records the promise. Never record a rule from inference or a passing complaint.",
    inputSchema: RecordCommitmentSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => stableToolResult(() => ({ ok: true, commitment: recordCommitment(args) })));

  server.registerTool("live_dashboard.end_commitment", {
    title: "End a commitment",
    description: "End a rule only when the user explicitly cancels or replaces it; a block rule's packages are released if no other rule holds them.",
    inputSchema: EndCommitmentSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(() => ({ ok: true, commitment: endCommitment(args.commitment_id, args.reason) })));

  server.registerTool("live_dashboard.list_commitments", {
    title: "List commitments",
    description: "Active commitments with today's exception usage and open exceptions. get_controller_context already includes this list.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => stableToolResult(() => ({ generated_at: new Date().toISOString(), commitments: commitmentsContext() })));

  server.registerTool("live_dashboard.request_exception_unfreeze", {
    title: "Request a time-boxed exception",
    description: "Open one package under an active block commitment for a concrete purpose and a bounded number of minutes. Live checks the rule's daily exception quota and maximum length, unfreezes, and re-freezes at relock_at on its own. Errors: not_committed (use a normal unfreeze), commitment_exception_denied (today's quota is used), exception_minutes_out_of_range, exception_purpose_required, device_offline.",
    inputSchema: ExceptionUnfreezeSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => stableToolResult(() => requestExceptionUnfreeze(args)));
}
