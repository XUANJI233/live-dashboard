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
    description: "Persist a rule the user explicitly set in his own conversation, quoting his words. A block rule names exact packages (at most 20) on an Android LSP device and an optional daily window; Live keeps them frozen inside the window by itself, re-freezing after the phone's nightly cleanup, and releases them when the window or the rule ends. A task rule only records the promise. Packages the phone does not have yet come back in not_installed and are frozen once installed. Errors: device_not_found, device_cannot_freeze, invalid_commitment_package, invalid_commitment_window, invalid_commitment_end. Never record a rule from inference, a passing complaint, or anyone else's words.",
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
    description: "Open one package under active block commitments for a concrete purpose and a bounded number of minutes. Every in-window rule holding the package must have quota left and is charged once; minutes are bounded by the strictest rule. Live unfreezes it and re-freezes it after relock_at on its own. Asking again while it is open returns the same exception (reused: true) without spending quota. Errors: not_committed (use a normal unfreeze), commitment_exception_denied (a rule's quota for today is used), exception_minutes_out_of_range, exception_purpose_required, device_offline and exception_not_delivered (no quota spent).",
    inputSchema: ExceptionUnfreezeSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => stableToolResult(() => requestExceptionUnfreeze(args)));
}
