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
    description: "Read individual completed AutoAccounting parent bills (Edited/Synced), newest first: default 50, max 200. For sums/counts/grouping use get_accounting_summary instead of paging and adding. When complete details are needed follow next_cursor until null with unchanged filters. Android refresh is attempted by default: inspect refresh and qualify stale/offline cached data. A bill alone does not prove a bypass; compare its event time with device and exception records. Pending/child bills and recognition rules are excluded.",
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
    description: "Use for totals/counts or category/shop/app/day groups of completed AutoAccounting parent bills (Edited/Synced), calculated in SQL; never page the bill list to add them yourself. Read totals.count and totals.sum_by_type: truncated=true only omits further groups, totals still cover the full query. group_limit defaults to 20, max 50. Group amounts mix matched types: filter transaction_types:[Expend] for spending. Inspect currency_codes and query each currency_code separately; never present mixed-currency sums as one currency. Day buckets use start's explicit offset. Same filters/refresh as get_accounting_bills; inspect refresh before treating cached data as current or complete.",
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
