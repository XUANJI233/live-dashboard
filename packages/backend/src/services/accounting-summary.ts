import { db } from "../db";
import {
  ACCOUNTING_GROUP_BY,
  ACCOUNTING_TRANSACTION_TYPES,
  MAX_ACCOUNTING_GROUP_LIMIT,
} from "./accounting-contracts";
import { accountingRange, accountingWhere, type AccountingFilter } from "./accounting-bill-filters";
import { boundedInteger } from "./bounded-integer";
import { cleanLooseIdentifier } from "./mcp-contracts";

// Totals and the largest groups of processed bills, added up by SQLite so a supervisor never has
// to page raw bills to answer "how much". Money is summed as recorded; currency_codes shows
// whether more than one currency was added together.

export const ACCOUNTING_SUMMARY_SCHEMA = "live_dashboard.accounting_summary.v1";
export type AccountingGroupBy = typeof ACCOUNTING_GROUP_BY[number];

const DEFAULT_GROUP_LIMIT = 20;
const EXPLICIT_OFFSET = /(?:Z|([+-])(\d{2}):(\d{2}))$/i;
const GROUP_COLUMNS: Record<Exclude<AccountingGroupBy, "day">, string> = {
  category: "category_name",
  shop: "shop_name",
  app: "app",
};

export interface AccountingSummaryOptions extends AccountingFilter {
  groupBy?: AccountingGroupBy;
  groupLimit?: number;
}

interface GroupRow {
  group_key: string;
  count: number;
  amount: number;
  group_count: number;
}

/** Validates everything first and returns the query, so a bad range fails before any Android refresh. */
export function accountingSummaryQuery(options: AccountingSummaryOptions): () => Record<string, unknown> {
  const startOffset = explicitOffsetMinutes(options.start, "invalid_accounting_start");
  explicitOffsetMinutes(options.end, "invalid_accounting_end");
  const range = accountingRange(options.start, options.end);
  const groupBy = (ACCOUNTING_GROUP_BY as readonly string[]).includes(String(options.groupBy))
    ? options.groupBy as AccountingGroupBy
    : "category";
  const groupLimit = boundedInteger(options.groupLimit, 1, MAX_ACCOUNTING_GROUP_LIMIT, DEFAULT_GROUP_LIMIT);
  return () => summarize(options, range, groupBy, groupLimit, startOffset);
}

function summarize(
  options: AccountingSummaryOptions,
  range: { start: string; end: string },
  groupBy: AccountingGroupBy,
  groupLimit: number,
  startOffset: number,
): Record<string, unknown> {
  const where = accountingWhere({ ...options, ...range });
  const whereSql = where.conditions.join(" AND ");
  // Day groups are local calendar days in the offset written in `start`.
  const keySql = groupBy === "day"
    ? `strftime('%Y-%m-%d', occurred_at, '${startOffset >= 0 ? "+" : ""}${startOffset} minutes')`
    : GROUP_COLUMNS[groupBy];

  const totalRows = db.prepare(`
    SELECT type, currency_code, COUNT(*) AS count, SUM(money) AS amount
    FROM accounting_bills
    WHERE ${whereSql}
    GROUP BY type, currency_code
  `).all(...where.params) as Array<{ type: string; currency_code: string; count: number; amount: number }>;
  const groupRows = db.prepare(`
    SELECT ${keySql} AS group_key, COUNT(*) AS count, ROUND(SUM(money), 2) AS amount,
           COUNT(*) OVER () AS group_count
    FROM accounting_bills
    WHERE ${whereSql}
    GROUP BY group_key
    ORDER BY amount DESC, group_key ASC
    LIMIT ?
  `).all(...where.params, groupLimit) as GroupRow[];
  const typeRows = groupRows.length === 0 ? [] : db.prepare(`
    SELECT ${keySql} AS group_key, type, SUM(money) AS amount
    FROM accounting_bills
    WHERE ${whereSql} AND ${keySql} IN (${groupRows.map(() => "?").join(", ")})
    GROUP BY group_key, type
  `).all(...where.params, ...groupRows.map((row) => row.group_key)) as Array<{ group_key: string; type: string; amount: number }>;

  const groupCount = groupRows[0]?.group_count ?? 0;
  return {
    schema: ACCOUNTING_SUMMARY_SCHEMA,
    range,
    device_id: options.deviceId ? cleanLooseIdentifier(options.deviceId, 160) || null : null,
    group_by: groupBy,
    ...(groupBy === "day" ? { day_offset: offsetLabel(startOffset) } : {}),
    currency_codes: [...new Set(totalRows.map((row) => row.currency_code))].sort(),
    totals: {
      count: totalRows.reduce((total, row) => total + row.count, 0),
      sum_by_type: sumByType(totalRows),
    },
    groups: groupRows.map((row) => ({
      key: row.group_key ?? "",
      count: row.count,
      amount: row.amount,
      sum_by_type: sumByType(typeRows.filter((typeRow) => typeRow.group_key === row.group_key)),
    })),
    group_count: groupCount,
    truncated: groupCount > groupRows.length,
  };
}

function sumByType(rows: Array<{ type: string; amount: number }>): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const type of ACCOUNTING_TRANSACTION_TYPES) {
    const matching = rows.filter((row) => row.type === type);
    if (matching.length === 0) continue;
    sums[type] = Math.round(matching.reduce((total, row) => total + row.amount, 0) * 100) / 100;
  }
  return sums;
}

/** Minutes to add to UTC for the offset written at the end of an ISO timestamp. */
function explicitOffsetMinutes(value: string, error: string): number {
  const match = EXPLICIT_OFFSET.exec(String(value ?? "").trim());
  if (!match) throw new Error(error);
  if (!match[1]) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  if (minutes > 14 * 60) throw new Error(error);
  return match[1] === "-" ? -minutes : minutes;
}

function offsetLabel(minutes: number): string {
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  return `${minutes < 0 ? "-" : "+"}${hours}:${String(absolute % 60).padStart(2, "0")}`;
}
