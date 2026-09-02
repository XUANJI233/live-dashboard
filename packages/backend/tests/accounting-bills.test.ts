import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "live-accounting-bills-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
process.env.MCP_SERVER_TOKEN = "accounting-mcp-token";
process.env.DEVICE_TOKEN_1 = "accounting-device-token:accounting-phone:Accounting Phone:android";

describe("AutoAccounting bill ingestion and MCP query", () => {
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // SQLite may retain a test handle briefly.
    }
  });

  test("stores only completed parent bills and upserts the same source bill", async () => {
    const { ingestAccountingBills, queryAccountingBills } = await import("../src/services/accounting-bills");

    const first = ingestAccountingBills("accounting-phone", uploadSnapshot([
        bill({ source_bill_id: "101", type: "Expend", money: 28.5, state: "Edited", shop_name: "Coffee" }),
        bill({ source_bill_id: "102", type: "Income", money: 100, state: "Synced", shop_name: "Refund" }),
        bill({ source_bill_id: "103", type: "Expend", money: 9, state: "Wait2Edit", shop_name: "Pending" }),
        bill({ source_bill_id: "104", type: "Expend", money: 12, state: "Edited", group_id: 101, shop_name: "Child" }),
      ]));

    expect(first).toMatchObject({ accepted: 2, skipped: 2 });

    const updated = ingestAccountingBills("accounting-phone", uploadSnapshot([
      bill({
        source_bill_id: "101",
        type: "Expend",
        money: 30,
        state: "Synced",
        shop_name: "Coffee corrected",
      }),
      bill({ source_bill_id: "102", type: "Income", money: 100, state: "Synced", shop_name: "Refund" }),
    ]));
    expect(updated).toMatchObject({ accepted: 2, skipped: 0, pruned: 0 });

    const result = queryAccountingBills({
      start: "2026-08-31T00:00:00.000Z",
      end: "2026-09-03T00:00:00.000Z",
      deviceId: "accounting-phone",
      limit: 20,
    });
    expect(result.bills).toHaveLength(2);
    expect(result.bills.find((item) => item.source_bill_id === "101")).toMatchObject({
      money: 30,
      state: "Synced",
      shop_name: "Coffee corrected",
    });
    expect(result.bills.some((item) => item.shop_name === "Pending")).toBe(false);
    expect(result.bills.some((item) => item.shop_name === "Child")).toBe(false);
  });

  test("returns bounded filters and a lossless cursor for additional pages", async () => {
    const { ingestAccountingBills, queryAccountingBills } = await import("../src/services/accounting-bills");
    ingestAccountingBills("accounting-phone", uploadSnapshot([
        bill({ source_bill_id: "201", type: "Expend", money: 20, currency_code: "CNY", category_name: "餐饮" }),
        bill({ source_bill_id: "202", type: "IncomeRefund", money: 5, currency_code: "CNY", category_name: "退款" }),
        bill({ source_bill_id: "203", type: "Income", money: 7, currency_code: "USD", category_name: "工资" }),
      ]));

    const result = queryAccountingBills({
      start: "2026-08-31T00:00:00.000Z",
      end: "2026-09-03T00:00:00.000Z",
      transactionTypes: ["Expend", "IncomeRefund"],
      keyword: "餐饮 退款",
      limit: 1,
    });

    expect(result.limit).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.next_cursor).toBeString();
    const next = queryAccountingBills({
      start: "2026-08-31T00:00:00.000Z",
      end: "2026-09-03T00:00:00.000Z",
      transactionTypes: ["Expend", "IncomeRefund"],
      keyword: "餐饮 退款",
      limit: 1,
      cursor: result.next_cursor!,
    });
    expect([...result.bills, ...next.bills].map((item) => item.source_bill_id).sort()).toEqual(["201", "202"]);
  });

  test("exposes accounting and Coyote tools through the existing MCP server", async () => {
    const { handleMcpRequest } = await import("../src/routes/mcp");
    const response = await handleMcpRequest(mcpRequest({ method: "tools/list" }), {
      remoteAddress: "127.0.0.1",
      localListener: true,
    });
    const body = await response.json() as { result?: { tools?: Array<{ name: string }> } };
    const names = body.result?.tools?.map((tool) => tool.name) ?? [];

    expect(names).toContain("live_dashboard.get_accounting_bills");
    expect(names).toContain("live_dashboard.get_coyote_status");
    expect(names).toContain("live_dashboard.coyote_start");
    expect(names).toContain("live_dashboard.coyote_adjust");
    expect(names).toContain("live_dashboard.coyote_change_wave");
    expect(names).toContain("live_dashboard.coyote_stop");
    expect(names).toContain("live_dashboard.coyote_emergency_stop");
  });

  test("accepts Android-authenticated uploads and returns cached bills through MCP", async () => {
    const { handleAccountingBillsUpload } = await import("../src/routes/accounting-bills");
    const { handleMcpRequest } = await import("../src/routes/mcp");
    const upload = await handleAccountingBillsUpload(new Request("http://localhost/api/accounting/bills", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer accounting-device-token",
      },
      body: JSON.stringify(uploadSnapshot([
        bill({ source_bill_id: "301", type: "Expend", money: 18, category_name: "交通" }),
      ])),
    }));
    expect(upload.status).toBe(200);
    expect(await upload.json()).toMatchObject({ ok: true, accepted: 1, skipped: 0 });

    const response = await handleMcpRequest(mcpRequest({
      method: "tools/call",
      params: {
        name: "live_dashboard.get_accounting_bills",
        arguments: {
          start: "2026-08-31T00:00:00.000Z",
          end: "2026-09-03T00:00:00.000Z",
          device_id: "accounting-phone",
          refresh_from_android: false,
          limit: 10,
        },
      },
    }), {
      remoteAddress: "127.0.0.1",
      localListener: true,
    });
    const body = await response.json() as {
      result?: { structuredContent?: { refresh?: { status?: string }; bills?: Array<{ source_bill_id?: string }> } };
    };
    expect(response.status).toBe(200);
    expect(body.result?.structuredContent?.refresh?.status).toBe("skipped");
    expect(body.result?.structuredContent?.bills?.some((item) => item.source_bill_id === "301")).toBe(true);
  });

  test("reports Coyote control as offline when no Android integration socket is connected", async () => {
    const { handleMcpRequest } = await import("../src/routes/mcp");
    const response = await handleMcpRequest(mcpRequest({
      method: "tools/call",
      params: {
        name: "live_dashboard.coyote_start",
        arguments: {
          device_id: "accounting-phone",
          request_id: `coyote_${crypto.randomUUID()}`,
          channel: "A",
          strength: 5,
          waveform: "pulse_mid",
        },
      },
    }), {
      remoteAddress: "127.0.0.1",
      localListener: true,
    });
    const body = await response.json() as {
      result?: { structuredContent?: { status?: string; error?: string } };
    };
    expect(body.result?.structuredContent).toMatchObject({
      status: "offline",
      error: "android_integration_offline",
    });
  });

  test("authenticates the Android integration websocket as a separate role", async () => {
    const { getWsInfo } = await import("../src/services/realtime");
    const info = getWsInfo(new Request("http://localhost/api/ws?role=integration", {
      headers: { Authorization: "Bearer accounting-device-token" },
    }));

    expect(info).not.toBeInstanceOf(Response);
    expect(info).toMatchObject({
      role: "integration",
      id: "accounting-phone",
      device: { platform: "android" },
    });
  });

  test("prunes bills removed or reverted inside a completed range snapshot", async () => {
    const { ingestAccountingBills, queryAccountingBills } = await import("../src/services/accounting-bills");
    ingestAccountingBills("accounting-phone", uploadSnapshot([
      bill({ source_bill_id: "401", state: "Edited" }),
      bill({ source_bill_id: "402", state: "Synced" }),
    ]));
    const reconciled = ingestAccountingBills("accounting-phone", uploadSnapshot([
      bill({ source_bill_id: "402", state: "Synced" }),
    ]));

    expect(reconciled.pruned).toBeGreaterThanOrEqual(1);
    const result = queryAccountingBills({
      start: "2026-08-31T00:00:00.000Z",
      end: "2026-09-03T00:00:00.000Z",
      deviceId: "accounting-phone",
      limit: 200,
    });
    expect(result.bills.some((item) => item.source_bill_id === "401")).toBe(false);
    expect(result.bills.some((item) => item.source_bill_id === "402")).toBe(true);
  });

  test("refreshes every online Android integration when no device is selected", async () => {
    const { handleAndroidIntegrationWsMessage, requestAccountingSync } = await import("../src/services/android-integration-control");
    const { realtimeSocketHub } = await import("../src/services/realtime-socket-hub");
    const sockets = ["a", "b"].map((suffix) => {
      const deviceId = `accounting-multi-${suffix}-${crypto.randomUUID()}`;
      const socket = {
        data: { role: "integration", id: deviceId },
        send(encoded: string) {
          const payload = JSON.parse(encoded) as Record<string, unknown>;
          if (payload.type === "accounting_sync_request") {
            queueMicrotask(() => handleAndroidIntegrationWsMessage(socket as never, {
              type: "accounting_sync_result",
              v: 1,
              request_id: payload.request_id,
              ok: true,
              status: "applied",
              accounting: { available: true, last_sync_at: "2026-09-02T00:00:00.000Z", last_error: "" },
            }));
          }
        },
        close() {},
        ping() {},
      };
      realtimeSocketHub.registerIntegration(socket as never);
      return socket;
    });

    const refreshed = await requestAccountingSync({
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-09-03T00:00:00.000Z",
    });

    expect(refreshed).toMatchObject({ ok: true, status: "applied" });
    expect((refreshed.devices as unknown[])).toHaveLength(2);
    sockets.forEach((socket) => realtimeSocketHub.removeIntegration(socket as never));
  });
});

function bill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_bill_id: "1",
    type: "Expend",
    currency_code: "CNY",
    money: 10,
    fee: 0,
    occurred_at: "2026-09-01T08:00:00.000Z",
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

function uploadSnapshot(bills: Record<string, unknown>[]): Record<string, unknown> {
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
      Authorization: "Bearer accounting-mcp-token",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, params: {}, ...message }),
  });
}
