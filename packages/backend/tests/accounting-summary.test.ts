import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-accounting-summary-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
process.env.MCP_SERVER_TOKEN = "accounting-summary-mcp-token";

const { ingestAccountingBills, queryAccountingBills } = await import("../src/services/accounting-bills");
const { accountingSummaryQuery } = await import("../src/services/accounting-summary");

const RANGE = { start: "2026-09-01T00:00:00+08:00", end: "2026-09-03T00:00:00+08:00" };
const VIEW_KEYS = new Set([
  "source_bill_id", "occurred_at", "type", "money", "currency_code",
  "category_name", "shop_name", "shop_item", "app", "remark",
]);

describe("AutoAccounting bill views for a supervisor", () => {
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite file locked until the process exits.
    }
  });

  test("lists compact bills, 50 by default, with the remark clipped", () => {
    ingestAccountingBills("acct-view", snapshot(Array.from({ length: 60 }, (_, index) => bill({
      source_bill_id: String(1_000 + index),
      occurred_at: new Date(Date.parse("2026-09-01T02:00:00.000Z") + index * 60_000).toISOString(),
      remark: `第${index}笔${"很长的备注".repeat(30)}`,
      tags: ["夜宵", "朋友"],
      shop_item: "",
    }))));

    const result = queryAccountingBills({ ...RANGE, deviceId: "acct-view" });

    expect(result.limit).toBe(50);
    expect(result.bills).toHaveLength(50);
    expect(result.truncated).toBe(true);
    for (const item of result.bills) {
      expect(Object.keys(item).every((key) => VIEW_KEYS.has(key))).toBe(true);
      expect(item).not.toHaveProperty("shop_item");
      expect(item).not.toHaveProperty("currency_code");
      expect([...item.remark!].length).toBeLessThanOrEqual(80);
      expect(item.remark!.endsWith("…")).toBe(true);
    }
    expect(JSON.stringify(result.bills).length).toBeLessThan(50 * 260);
  });

  test("matches Chinese words inside text in both the list and the summary, wildcards escaped", () => {
    ingestAccountingBills("acct-keyword", snapshot([
      bill({ source_bill_id: "1", shop_name: "星巴克咖啡（国贸店）", money: 38 }),
      bill({ source_bill_id: "2", shop_item: "冰美式咖啡", money: 25 }),
      bill({ source_bill_id: "3", remark: "和同学一起喝咖啡", money: 12 }),
      bill({ source_bill_id: "4", tags: ["咖啡因"], money: 9 }),
      bill({ source_bill_id: "5", shop_name: "满100减50%活动", money: 100 }),
      bill({ source_bill_id: "6", shop_name: "满100减50元活动", money: 100 }),
      bill({ source_bill_id: "7", shop_name: "地铁", category_name: "交通", money: 4 }),
    ]));

    const coffee = queryAccountingBills({ ...RANGE, deviceId: "acct-keyword", keyword: "咖啡" });
    expect(coffee.bills.map((item) => item.source_bill_id).sort()).toEqual(["1", "2", "3", "4"]);
    const percent = queryAccountingBills({ ...RANGE, deviceId: "acct-keyword", keyword: "50%" });
    expect(percent.bills.map((item) => item.source_bill_id)).toEqual(["5"]);
    const underscore = queryAccountingBills({ ...RANGE, deviceId: "acct-keyword", keyword: "_" });
    expect(underscore.bills).toHaveLength(0);

    const summary = accountingSummaryQuery({ ...RANGE, deviceId: "acct-keyword", keyword: "咖啡 地铁" })();
    expect(summary.totals).toEqual({ count: 5, sum_by_type: { Expend: 88 } });
  });

  test("adds bills up in SQL with ranked, bounded groups", () => {
    ingestAccountingBills("acct-sum", snapshot([
      bill({ source_bill_id: "1", money: 30, category_name: "餐饮", shop_name: "面馆" }),
      bill({ source_bill_id: "2", money: 20.1, category_name: "餐饮", shop_name: "面馆" }),
      bill({ source_bill_id: "3", money: 100, category_name: "购物", shop_name: "超市" }),
      bill({ source_bill_id: "4", type: "IncomeRefund", money: 5, category_name: "购物", shop_name: "超市" }),
      bill({ source_bill_id: "5", type: "Income", money: 500, category_name: "工资", shop_name: "" }),
      // 01:30 on 2 September in UTC+08:00.
      bill({ source_bill_id: "6", money: 7, category_name: "餐饮", occurred_at: "2026-09-01T17:30:00.000Z" }),
      bill({ source_bill_id: "7", money: 3, currency_code: "USD", category_name: "订阅" }),
    ]));
    const summarize = (options: Record<string, unknown>) => accountingSummaryQuery({
      ...RANGE,
      deviceId: "acct-sum",
      ...options,
    })() as {
      currency_codes: string[];
      totals: { count: number; sum_by_type: Record<string, number> };
      groups: Array<{ key: string; count: number; amount: number; sum_by_type: Record<string, number> }>;
      group_count: number;
      truncated: boolean;
      day_offset?: string;
    };

    const byCategory = summarize({});
    expect(byCategory.currency_codes).toEqual(["CNY", "USD"]);
    expect(byCategory.totals).toEqual({ count: 7, sum_by_type: { Expend: 160.1, Income: 500, IncomeRefund: 5 } });
    expect(byCategory.groups.map((group) => [group.key, group.amount])).toEqual([
      ["工资", 500], ["购物", 105], ["餐饮", 57.1], ["订阅", 3],
    ]);
    expect(byCategory.groups[1]?.sum_by_type).toEqual({ Expend: 100, IncomeRefund: 5 });
    expect(byCategory.truncated).toBe(false);

    const spending = summarize({ transactionTypes: ["Expend"], currencyCode: "CNY", groupLimit: 1 });
    expect(spending.totals.count).toBe(4);
    expect(spending.groups).toEqual([{ key: "购物", count: 1, amount: 100, sum_by_type: { Expend: 100 } }]);
    expect(spending.group_count).toBe(2);
    expect(spending.truncated).toBe(true);

    const byDay = summarize({ groupBy: "day", currencyCode: "CNY" });
    expect(byDay.day_offset).toBe("+08:00");
    expect(byDay.groups.map((group) => [group.key, group.count])).toEqual([["2026-09-01", 5], ["2026-09-02", 1]]);

    const byShop = summarize({ groupBy: "shop", transactionTypes: ["Expend"] });
    expect(byShop.groups[0]).toMatchObject({ key: "超市", amount: 100 });

    expect(() => accountingSummaryQuery({ start: "2026-09-01T00:00:00", end: RANGE.end })).toThrow("invalid_accounting_start");
    expect(() => accountingSummaryQuery({ start: RANGE.end, end: RANGE.start })).toThrow("invalid_accounting_range");
  });

  test("serves the summary over MCP with the same Android refresh as the bill list", async () => {
    const { handleMcpRequest } = await import("../src/routes/mcp");
    const access = { remoteAddress: "127.0.0.1", localListener: true };
    const listed = await handleMcpRequest(mcpRequest({ method: "tools/list" }), access);
    const tools = ((await listed.json()) as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? [];
    expect(tools.map((tool) => tool.name)).toContain("live_dashboard.get_accounting_summary");

    const call = async (args: Record<string, unknown>) => {
      const response = await handleMcpRequest(mcpRequest({
        method: "tools/call",
        params: { name: "live_dashboard.get_accounting_summary", arguments: { ...RANGE, device_id: "acct-sum", ...args } },
      }), access);
      return ((await response.json()) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> } }).result;
    };

    const skipped = await call({ refresh_from_android: false, group_by: "app", transaction_types: ["Expend"] });
    expect(skipped?.structuredContent).toMatchObject({
      refresh: { status: "skipped" },
      group_by: "app",
      totals: { count: 5 },
    });
    // No Android integration is connected here: the summary still answers from the cache.
    const offline = await call({});
    expect(offline?.structuredContent).toMatchObject({ refresh: { ok: false, status: "offline" }, totals: { count: 7 } });
    const invalid = await call({ start: "2026-09-01 00:00" });
    expect(invalid?.isError).toBe(true);
    expect(invalid?.structuredContent).toEqual({ ok: false, error: "invalid_accounting_start" });
  });
});

function bill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_bill_id: "1",
    type: "Expend",
    currency_code: "CNY",
    money: 10,
    fee: 0,
    occurred_at: "2026-09-01T04:00:00.000Z",
    shop_name: "Shop",
    shop_item: "Item",
    category_name: "General",
    book_name: "Default",
    account_name_from: "Wallet",
    account_name_to: "",
    app: "WeChat",
    channel: "payment",
    state: "Edited",
    remark: "",
    auto: true,
    rule_name: "rule",
    tags: [],
    flag: 0,
    group_id: -1,
    ...overrides,
  };
}

function snapshot(bills: Record<string, unknown>[]): Record<string, unknown> {
  return {
    source: "autoaccounting",
    sync_id: `accounting_${crypto.randomUUID()}`,
    range_start: "2026-08-31T00:00:00.000Z",
    range_end: "2026-09-03T00:00:00.000Z",
    batch_index: 0,
    batch_count: 1,
    bills,
  };
}

function mcpRequest(message: Record<string, unknown>): Request {
  return new Request("http://127.0.0.1/api/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      Authorization: "Bearer accounting-summary-mcp-token",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, params: {}, ...message }),
  });
}
