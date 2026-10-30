import { db } from "../db";
import { cleanLooseIdentifier, cleanText } from "./mcp-contracts";
import { ACCOUNTING_TRANSACTION_TYPES } from "./accounting-contracts";
import {
  accountingRange,
  accountingWhere,
  MAX_ACCOUNTING_RANGE_DAYS,
  type AccountingFilter,
} from "./accounting-bill-filters";
import { clippedText } from "./clipped-text";

export const ACCOUNTING_BILLS_SCHEMA = "live_dashboard.accounting_bills.v1";
export const ACCOUNTING_SOURCE = "autoaccounting";

const MAX_BILLS_PER_UPLOAD = 500;
const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 200;
const MAX_VIEW_REMARK_LENGTH = 80;
const COMPLETED_STATES = new Set(["Edited", "Synced"]);
const TRANSACTION_TYPES = new Set<string>(ACCOUNTING_TRANSACTION_TYPES);

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
  sync_id?: unknown;
  range_start?: unknown;
  range_end?: unknown;
  batch_index?: unknown;
  batch_count?: unknown;
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

export interface AccountingBillView {
  source_bill_id: string;
  occurred_at: string;
  type: string;
  money: number;
  currency_code?: string;
  category_name?: string;
  shop_name?: string;
  shop_item?: string;
  app?: string;
  remark?: string;
}

type AccountingBillViewRow = Pick<
  AccountingBillRecord,
  "device_id" | "source_bill_id" | "occurred_at" | "type" | "money" | "currency_code"
  | "category_name" | "shop_name" | "shop_item" | "app" | "remark"
>;

interface AccountingCursor {
  occurred_at: string;
  device_id: string;
  source_bill_id: string;
}

const upsertBill = db.prepare(`
  INSERT INTO accounting_bills (
    device_id, source, source_bill_id, type, currency_code, money, fee,
    occurred_at, shop_name, shop_item, category_name, book_name,
    account_name_from, account_name_to, app, channel, state, remark,
    auto, rule_name, tags, flag, last_sync_id, updated_at
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, datetime('now')
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
    last_sync_id = excluded.last_sync_id,
    updated_at = datetime('now')
`);

const reconcileRange = db.prepare(`
  DELETE FROM accounting_bills
  WHERE device_id = ?
    AND source = ?
    AND occurred_at >= ?
    AND occurred_at < ?
    AND last_sync_id != ?
`);

export function ingestAccountingBills(
  deviceIdInput: string,
  payload: AccountingUploadPayload,
): { schema: typeof ACCOUNTING_BILLS_SCHEMA; sync_id: string; accepted: number; skipped: number; pruned: number } {
  const deviceId = cleanLooseIdentifier(deviceIdInput, 160);
  if (!deviceId) throw new Error("invalid_device_id");
  if (payload.source !== ACCOUNTING_SOURCE) throw new Error("unsupported_accounting_source");
  const syncId = cleanSyncId(payload.sync_id);
  const rangeStart = normalizeIso(payload.range_start);
  const rangeEnd = normalizeIso(payload.range_end);
  const batchIndex = finiteInteger(payload.batch_index, Number.NaN);
  const batchCount = finiteInteger(payload.batch_count, Number.NaN);
  if (!syncId || !rangeStart || !rangeEnd || Date.parse(rangeEnd) <= Date.parse(rangeStart)) {
    throw new Error("invalid_accounting_sync_snapshot");
  }
  if (Date.parse(rangeEnd) - Date.parse(rangeStart) > MAX_ACCOUNTING_RANGE_DAYS * 24 * 60 * 60_000) {
    throw new Error("accounting_range_too_large");
  }
  if (batchCount < 1 || batchCount > 10_000 || batchIndex < 0 || batchIndex >= batchCount) {
    throw new Error("invalid_accounting_sync_batch");
  }
  if (!Array.isArray(payload.bills)) throw new Error("invalid_accounting_bills");
  if (payload.bills.length > MAX_BILLS_PER_UPLOAD) throw new Error("accounting_batch_too_large");
  const inputBills = payload.bills;
  let accepted = 0;
  let skipped = 0;
  let pruned = 0;

  const commit = db.transaction(() => {
    for (const input of inputBills) {
      const normalized = normalizeUploadedBill(input);
      if (!normalized) {
        skipped += 1;
        continue;
      }
      if (normalized.occurred_at < rangeStart || normalized.occurred_at >= rangeEnd) {
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
        syncId,
      );
      accepted += 1;
    }
    if (batchIndex === batchCount - 1) {
      pruned = Number(reconcileRange.run(deviceId, ACCOUNTING_SOURCE, rangeStart, rangeEnd, syncId).changes);
    }
  });
  commit();

  return { schema: ACCOUNTING_BILLS_SCHEMA, sync_id: syncId, accepted, skipped, pruned };
}

export function queryAccountingBills(options: Omit<AccountingFilter, "currencyCode"> & {
  limit?: number;
  cursor?: string;
}): {
  schema: typeof ACCOUNTING_BILLS_SCHEMA;
  range: { start: string; end: string };
  device_id: string | null;
  limit: number;
  truncated: boolean;
  bills: AccountingBillView[];
  next_cursor: string | null;
} {
  const range = accountingRange(options.start, options.end);
  const limit = integer(options.limit, 1, MAX_QUERY_LIMIT, DEFAULT_QUERY_LIMIT);
  const cursor = decodeCursor(options.cursor);
  const where = accountingWhere({ ...options, ...range });
  if (cursor) {
    where.conditions.push(`(
      occurred_at < ? OR
      (occurred_at = ? AND device_id > ?) OR
      (occurred_at = ? AND device_id = ? AND source_bill_id < ?)
    )`);
    where.params.push(
      cursor.occurred_at,
      cursor.occurred_at,
      cursor.device_id,
      cursor.occurred_at,
      cursor.device_id,
      cursor.source_bill_id,
    );
  }
  const rows = db.prepare(`
    SELECT device_id, source_bill_id, occurred_at, type, money, currency_code,
           category_name, shop_name, shop_item, app, remark
    FROM accounting_bills
    WHERE ${where.conditions.join(" AND ")}
    ORDER BY occurred_at DESC, device_id ASC, source_bill_id DESC
    LIMIT ?
  `).all(...where.params, limit + 1) as AccountingBillViewRow[];
  const visibleRows = rows.slice(0, limit);

  return {
    schema: ACCOUNTING_BILLS_SCHEMA,
    range,
    device_id: options.deviceId ? cleanLooseIdentifier(options.deviceId, 160) || null : null,
    limit,
    truncated: rows.length > visibleRows.length,
    bills: visibleRows.map(billView),
    next_cursor: rows.length > visibleRows.length && visibleRows.length > 0
      ? encodeCursor(visibleRows[visibleRows.length - 1]!)
      : null,
  };
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

// What a supervisor reads per bill; sync bookkeeping stays in the table. Empty text is left out,
// and the currency only appears when it is not CNY.
function billView(row: AccountingBillViewRow): AccountingBillView {
  const view: AccountingBillView = {
    source_bill_id: row.source_bill_id,
    occurred_at: row.occurred_at,
    type: row.type,
    money: row.money,
  };
  if (row.currency_code !== "CNY") view.currency_code = row.currency_code;
  for (const key of ["category_name", "shop_name", "shop_item", "app"] as const) {
    if (row[key]) view[key] = row[key];
  }
  if (row.remark) view.remark = clippedText(row.remark, MAX_VIEW_REMARK_LENGTH);
  return view;
}

function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanText(item, 60)).filter(Boolean).slice(0, 20);
}

function numericId(value: unknown): string {
  const text = String(value ?? "").trim();
  return /^\d{1,19}$/.test(text) ? text : "";
}

function cleanSyncId(value: unknown): string {
  const text = String(value ?? "").trim();
  return /^accounting_[a-f0-9-]{36}$/.test(text) ? text : "";
}

function encodeCursor(row: Pick<AccountingBillViewRow, "occurred_at" | "device_id" | "source_bill_id">): string {
  return Buffer.from(JSON.stringify({
    occurred_at: row.occurred_at,
    device_id: row.device_id,
    source_bill_id: row.source_bill_id,
  }), "utf8").toString("base64url");
}

function decodeCursor(value: unknown): AccountingCursor | null {
  if (typeof value !== "string" || !value || value.length > 500) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    const occurredAt = normalizeIso(parsed.occurred_at);
    const deviceId = cleanLooseIdentifier(parsed.device_id, 160);
    const sourceBillId = numericId(parsed.source_bill_id);
    if (!occurredAt || !deviceId || !sourceBillId) throw new Error("invalid_accounting_cursor");
    return { occurred_at: occurredAt, device_id: deviceId, source_bill_id: sourceBillId };
  } catch {
    throw new Error("invalid_accounting_cursor");
  }
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
