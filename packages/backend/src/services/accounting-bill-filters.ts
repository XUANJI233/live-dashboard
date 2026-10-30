import { ACCOUNTING_TRANSACTION_TYPES } from "./accounting-contracts";
import { cleanLooseIdentifier, cleanText, normalizeIsoTimestamp } from "./mcp-contracts";

// One WHERE clause for every bill read, so the bill list and the summary match the same bills.
// Keywords are LIKE substrings with the wildcards escaped, so a Chinese word matches inside
// longer text; a bill matches when any of the words appears in any of the text columns.

export const MAX_ACCOUNTING_RANGE_DAYS = 3_650;

const TRANSACTION_TYPES = new Set<string>(ACCOUNTING_TRANSACTION_TYPES);
const KEYWORD_COLUMNS = ["shop_name", "shop_item", "category_name", "remark", "app", "channel", "tags"];
const MAX_KEYWORDS = 6;

export interface AccountingFilter {
  start: string;
  end: string;
  deviceId?: string;
  transactionTypes?: string[];
  category?: string;
  keyword?: string;
  currencyCode?: string;
}

export function accountingRange(startInput: string, endInput: string): { start: string; end: string } {
  const start = normalizeIsoTimestamp(startInput);
  if (!start) throw new Error("invalid_accounting_start");
  const end = normalizeIsoTimestamp(endInput);
  if (!end) throw new Error("invalid_accounting_end");
  if (Date.parse(end) <= Date.parse(start)) throw new Error("invalid_accounting_range");
  if (Date.parse(end) - Date.parse(start) > MAX_ACCOUNTING_RANGE_DAYS * 24 * 60 * 60_000) {
    throw new Error("accounting_range_too_large");
  }
  return { start, end };
}

/** `start`/`end` must already be normalized by accountingRange. */
export function accountingWhere(filter: AccountingFilter): { conditions: string[]; params: Array<string | number> } {
  const conditions = ["occurred_at >= ?", "occurred_at < ?"];
  const params: Array<string | number> = [filter.start, filter.end];
  const deviceId = cleanLooseIdentifier(filter.deviceId, 160);
  if (deviceId) {
    conditions.push("device_id = ?");
    params.push(deviceId);
  }
  const transactionTypes = (filter.transactionTypes ?? [])
    .map((item) => cleanText(item, 40))
    .filter((item, index, all) => TRANSACTION_TYPES.has(item) && all.indexOf(item) === index);
  if (transactionTypes.length > 0) {
    conditions.push(`type IN (${transactionTypes.map(() => "?").join(", ")})`);
    params.push(...transactionTypes);
  }
  const category = cleanText(filter.category, 100);
  if (category) {
    conditions.push("category_name = ?");
    params.push(category);
  }
  const currencyCode = cleanText(filter.currencyCode, 12).toUpperCase();
  if (currencyCode) {
    conditions.push("currency_code = ?");
    params.push(currencyCode);
  }
  const keywords = cleanText(filter.keyword, 200).split(" ").filter(Boolean).slice(0, MAX_KEYWORDS);
  if (keywords.length > 0) {
    const keywordClause = `(${KEYWORD_COLUMNS.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`;
    conditions.push(`(${keywords.map(() => keywordClause).join(" OR ")})`);
    for (const keyword of keywords) {
      params.push(...KEYWORD_COLUMNS.map(() => `%${escapeLike(keyword)}%`));
    }
  }
  return { conditions, params };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
