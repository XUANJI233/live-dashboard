import { db } from "../db";
import { cleanLooseIdentifier, cleanText } from "./mcp-contracts";

export const ACCOUNTING_BILLS_SCHEMA = "live_dashboard.accounting_bills.v1";
export const ACCOUNTING_SOURCE = "autoaccounting";

const MAX_BILLS_PER_UPLOAD = 500;
const MAX_QUERY_LIMIT = 200;
const MAX_QUERY_RANGE_DAYS = 3_650;
const COMPLETED_STATES = new Set(["Edited", "Synced"]);
const TRANSACTION_TYPES = new Set([
  "Expend",
  "ExpendReimbursement",
  "ExpendLending",
  "ExpendRepayment",
  "Income",
  "IncomeLending",
  "IncomeRepayment",
  "IncomeReimbursement",
  "IncomeRefund",
  "Transfer",
]);

export interface AccountingBillUpload {
  source_bill_id?: unknown;
  type?: unknown;
  currency_code?: unknown;
  money?: unknown;
  fee?: unknown;
  occurred_at?: unknown;
  shop_name?: unknown;
  shop_item?: unknown;
  category_name?: unknown;
  book_name?: unknown;
  account_name_from?: unknown;
  account_name_to?: unknown;
  app?: unknown;
  channel?: unknown;
  state?: unknown;
  remark?: unknown;
  auto?: unknown;
  rule_name?: unknown;
  tags?: unknown;
  flag?: unknown;
  group_id?: unknown;
}

export interface AccountingUploadPayload {
  source?: unknown;
  bills?: unknown;
}

export interface AccountingBillRecord {
  device_id: string;
  source: string;
  source_bill_id: string;
  type: string;
  currency_code: string;
  money: number;
  fee: number;
  occurred_at: string;
  shop_name: string;
  shop_item: string;
  category_name: string;
  book_name: string;
  account_name_from: string;
  account_name_to: string;
  app: string;
  channel: string;
  state: string;
  remark: string;
  auto: boolean;
  rule_name: string;
  tags: string[];
  flag: number;
}

interface AccountingBillRow extends Omit<AccountingBillRecord, "auto" | "tags"> {
  auto: number;
  tags: string;
}

const upsertBill = db.prepare(`
  INSERT INTO accounting_bills (
    device_id, source, source_bill_id, type, currency_code, money, fee,
    occurred_at, shop_name, shop_item, category_name, book_name,
    account_name_from, account_name_to, app, channel, state, remark,
    auto, rule_name, tags, flag, updated_at
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, datetime('now')
  )
  ON CONFLICT(device_id, source, source_bill_id) DO UPDATE SET
    type = excluded.type,
    currency_code = excluded.currency_code,
    money = excluded.money,
    fee = excluded.fee,
    occurred_at = excluded.occurred_at,
    shop_name = excluded.shop_name,
    shop_item = excluded.shop_item,
    category_name = excluded.category_name,
    book_name = excluded.book_name,
    account_name_from = excluded.account_name_from,
    account_name_to = excluded.account_name_to,
    app = excluded.app,
    channel = excluded.channel,
    state = excluded.state,
    remark = excluded.remark,
    auto = excluded.auto,
    rule_name = excluded.rule_name,
    tags = excluded.tags,
    flag = excluded.flag,
    updated_at = datetime('now')
`);

export function ingestAccountingBills(
  deviceIdInput: string,
  payload: AccountingUploadPayload,
): { schema: typeof ACCOUNTING_BILLS_SCHEMA; accepted: number; skipped: number } {
  const deviceId = cleanLooseIdentifier(deviceIdInput, 160);
  if (!deviceId) throw new Error("invalid_device_id");
  if (payload.source !== ACCOUNTING_SOURCE) throw new Error("unsupported_accounting_source");
  const inputBills = Array.isArray(payload.bills) ? payload.bills.slice(0, MAX_BILLS_PER_UPLOAD) : [];
  let accepted = 0;
  let skipped = Array.isArray(payload.bills) ? Math.max(0, payload.bills.length - inputBills.length) : 0;

  const commit = db.transaction(() => {
    for (const input of inputBills) {
      const normalized = normalizeUploadedBill(input);
      if (!normalized) {
        skipped += 1;
        continue;
      }
      upsertBill.run(
        deviceId,
        ACCOUNTING_SOURCE,
        normalized.source_bill_id,
        normalized.type,
        normalized.currency_code,
        normalized.money,
        normalized.fee,
        normalized.occurred_at,
        normalized.shop_name,
        normalized.shop_item,
        normalized.category_name,
        normalized.book_name,
        normalized.account_name_from,
        normalized.account_name_to,
        normalized.app,
        normalized.channel,
        normalized.state,
        normalized.remark,
        normalized.auto ? 1 : 0,
        normalized.rule_name,
        JSON.stringify(normalized.tags),
        normalized.flag,
      );
      accepted += 1;
    }
  });
  commit();

  return { schema: ACCOUNTING_BILLS_SCHEMA, accepted, skipped };
}

export function queryAccountingBills(options: {
  start: string;
  end: string;
  deviceId?: string;
  transactionTypes?: string[];
  category?: string;
  keyword?: string;
  limit?: number;
}): {
  schema: typeof ACCOUNTING_BILLS_SCHEMA;
  range: { start: string; end: string };
  device_id: string | null;
  limit: number;
  truncated: boolean;
  bills: AccountingBillRecord[];
  summary_by_currency: Record<string, AccountingCurrencySummary>;
} {
  const start = isoTimestamp(options.start, "invalid_accounting_start");
  const end = isoTimestamp(options.end, "invalid_accounting_end");
  if (Date.parse(end) <= Date.parse(start)) throw new Error("invalid_accounting_range");
  if (Date.parse(end) - Date.parse(start) > MAX_QUERY_RANGE_DAYS * 24 * 60 * 60_000) {
    throw new Error("accounting_range_too_large");
  }
  const limit = integer(options.limit, 1, MAX_QUERY_LIMIT, 100);
  const where = accountingWhere({ ...options, start, end });
  const rows = db.prepare(`
    SELECT * FROM accounting_bills
    WHERE ${where.sql}
    ORDER BY occurred_at DESC, source_bill_id DESC
    LIMIT ?
  `).all(...where.params, limit + 1) as AccountingBillRow[];
  const visibleRows = rows.slice(0, limit);

  const summaries = db.prepare(`
    SELECT currency_code, type, SUM(money) AS amount, COUNT(*) AS count
    FROM accounting_bills
    WHERE ${where.sql}
    GROUP BY currency_code, type
  `).all(...where.params) as Array<{ currency_code: string; type: string; amount: number; count: number }>;

  return {
    schema: ACCOUNTING_BILLS_SCHEMA,
    range: { start, end },
    device_id: options.deviceId ? cleanLooseIdentifier(options.deviceId, 160) || null : null,
    limit,
    truncated: rows.length > visibleRows.length,
    bills: visibleRows.map(publicBill),
    summary_by_currency: summarizeCurrencies(summaries),
  };
}

interface AccountingCurrencySummary {
  income: number;
  expense: number;
  refund: number;
  transfer: number;
  count: number;
}

function normalizeUploadedBill(value: unknown): AccountingBillRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as AccountingBillUpload;
  const sourceBillId = numericId(input.source_bill_id);
  const type = cleanText(input.type, 40);
  const state = cleanText(input.state, 20);
  const groupId = finiteInteger(input.group_id, Number.NaN);
  const occurredAt = normalizeIso(input.occurred_at);
  const money = finiteNumber(input.money);
  if (!sourceBillId || !TRANSACTION_TYPES.has(type) || !COMPLETED_STATES.has(state)) return null;
  if (groupId !== -1 || !occurredAt || money == null || money < 0) return null;

  return {
    device_id: "",
    source: ACCOUNTING_SOURCE,
    source_bill_id: sourceBillId,
    type,
    currency_code: currencyCode(input.currency_code),
    money: roundedMoney(money),
    fee: roundedMoney(finiteNumber(input.fee) ?? 0),
    occurred_at: occurredAt,
    shop_name: cleanText(input.shop_name, 160),
    shop_item: cleanText(input.shop_item, 160),
    category_name: cleanText(input.category_name, 100),
    book_name: cleanText(input.book_name, 100),
    account_name_from: cleanText(input.account_name_from, 100),
    account_name_to: cleanText(input.account_name_to, 100),
    app: cleanText(input.app, 100),
    channel: cleanText(input.channel, 120),
    state,
    remark: cleanText(input.remark, 500),
    auto: input.auto === true,
    rule_name: cleanText(input.rule_name, 160),
    tags: cleanTags(input.tags),
    flag: finiteInteger(input.flag, 0),
  };
}

function accountingWhere(options: {
  start: string;
  end: string;
  deviceId?: string;
  transactionTypes?: string[];
  category?: string;
  keyword?: string;
}): { sql: string; params: Array<string | number> } {
  const conditions = ["occurred_at >= ?", "occurred_at < ?"];
  const params: Array<string | number> = [options.start, options.end];
  const deviceId = cleanLooseIdentifier(options.deviceId, 160);
  if (deviceId) {
    conditions.push("device_id = ?");
    params.push(deviceId);
  }
  const transactionTypes = (options.transactionTypes ?? [])
    .map((item) => cleanText(item, 40))
    .filter((item, index, all) => TRANSACTION_TYPES.has(item) && all.indexOf(item) === index)
    .slice(0, TRANSACTION_TYPES.size);
  if (transactionTypes.length > 0) {
    conditions.push(`type IN (${transactionTypes.map(() => "?").join(", ")})`);
    params.push(...transactionTypes);
  }
  const category = cleanText(options.category, 100);
  if (category) {
    conditions.push("category_name = ?");
    params.push(category);
  }
  const keywords = cleanText(options.keyword, 200).split(" ").filter(Boolean).slice(0, 6);
  if (keywords.length > 0) {
    const textColumns = ["shop_name", "shop_item", "category_name", "remark", "app", "channel", "tags"];
    const keywordClauses = keywords.map(() => `(${textColumns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    conditions.push(`(${keywordClauses.join(" OR ")})`);
    for (const keyword of keywords) {
      params.push(...textColumns.map(() => `%${escapeLike(keyword)}%`));
    }
  }
  return { sql: conditions.join(" AND "), params };
}

function summarizeCurrencies(
  rows: Array<{ currency_code: string; type: string; amount: number; count: number }>,
): Record<string, AccountingCurrencySummary> {
  const out: Record<string, AccountingCurrencySummary> = {};
  for (const row of rows) {
    const summary = out[row.currency_code] ?? { income: 0, expense: 0, refund: 0, transfer: 0, count: 0 };
    const amount = roundedMoney(Number(row.amount) || 0);
    summary.count += Number(row.count) || 0;
    if (row.type === "Income") summary.income = roundedMoney(summary.income + amount);
    if (row.type === "Expend") summary.expense = roundedMoney(summary.expense + amount);
    if (row.type === "IncomeRefund") {
      summary.refund = roundedMoney(summary.refund + amount);
      summary.expense = roundedMoney(summary.expense - amount);
    }
    if (row.type === "Transfer") summary.transfer = roundedMoney(summary.transfer + amount);
    out[row.currency_code] = summary;
  }
  return out;
}

function publicBill(row: AccountingBillRow): AccountingBillRecord {
  return {
    ...row,
    auto: row.auto === 1,
    tags: parseTags(row.tags),
  };
}

function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanText(item, 60)).filter(Boolean).slice(0, 20);
}

function parseTags(value: string): string[] {
  try {
    return cleanTags(JSON.parse(value));
  } catch {
    return [];
  }
}

function numericId(value: unknown): string {
  const text = String(value ?? "").trim();
  return /^\d{1,19}$/.test(text) ? text : "";
}

function currencyCode(value: unknown): string {
  const code = cleanText(value, 12).toUpperCase();
  return /^[A-Z0-9]{2,8}$/.test(code) ? code : "CNY";
}

function normalizeIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function isoTimestamp(value: string, error: string): string {
  const normalized = normalizeIso(value);
  if (!normalized) throw new Error(error);
  return normalized;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

function roundedMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function integer(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
