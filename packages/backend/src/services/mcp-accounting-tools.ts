import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { queryAccountingBills } from "./accounting-bills";
import { accountingSummaryQuery } from "./accounting-summary";
import { requestAccountingSync } from "./android-integration-control";
import { AccountingBillsSchema, AccountingSummarySchema } from "./mcp-accounting-schemas";
import { stableToolResult } from "./mcp-tool-result";

// AutoAccounting bills: a compact list for reading individual bills and a SQL summary for adding
// them up. Both refresh from the online Android integration first unless told not to.
export function registerAccountingTools(server: McpServer): void {
  server.registerTool("live_dashboard.get_accounting_bills", {
    title: "Get processed AutoAccounting bills",
    description: "Ask an online Android integration to read AutoAccounting's completed parent bills (Edited/Synced), cache them idempotently, then query the bounded server copy. Returns compact bills, newest first; to add bills up, use get_accounting_summary instead of paging. Recognition rules and pending Wait2Edit data are never reproduced here.",
    inputSchema: AccountingBillsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(async () => {
    const refresh = await refreshFromAndroid(args);
    return {
      refresh,
      ...queryAccountingBills({
        start: args.start,
        end: args.end,
        deviceId: args.device_id,
        transactionTypes: args.transaction_types,
        category: args.category,
        keyword: args.keyword,
        limit: args.limit,
        cursor: args.cursor,
      }),
    };
  }));

  server.registerTool("live_dashboard.get_accounting_summary", {
    title: "Summarize processed AutoAccounting bills",
    description: "Add up completed AutoAccounting bills (Edited/Synced) in SQL: totals (count, money per transaction type) and the largest groups by category, shop, app, or local day, sorted by amount. Same filters and Android refresh as get_accounting_bills. A group's amount adds every matched type; pass transaction_types (e.g. Expend) to rank spending. truncated=true means more groups exist.",
    inputSchema: AccountingSummarySchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(async () => {
    const summarize = accountingSummaryQuery({
      start: args.start,
      end: args.end,
      deviceId: args.device_id,
      transactionTypes: args.transaction_types,
      category: args.category,
      keyword: args.keyword,
      currencyCode: args.currency_code,
      groupBy: args.group_by,
      groupLimit: args.group_limit,
    });
    const refresh = await refreshFromAndroid(args);
    return { refresh, ...summarize() };
  }));
}

function refreshFromAndroid(args: {
  refresh_from_android?: boolean;
  device_id?: string;
  start: string;
  end: string;
}): Promise<Record<string, unknown>> | Record<string, unknown> {
  return args.refresh_from_android === false
    ? { ok: true, status: "skipped" }
    : requestAccountingSync({ deviceId: args.device_id, start: args.start, end: args.end });
}
