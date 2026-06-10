import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { SendCommandsSchema, type SendCommandsArgs } from "./mcp-tool-schemas";

const DEFAULT_MCP_PORT = 3031;
const MCP_HOST = "127.0.0.1";
const SEND_DEVICE_COMMANDS_TOOL_NAME = "live_dashboard.send_device_commands";

export interface McpSendDeviceCommandsResult {
  request_id: string;
  commands: unknown[];
  [key: string]: unknown;
}

export async function sendDeviceCommandsViaMcp(input: SendCommandsArgs): Promise<McpSendDeviceCommandsResult> {
  return withLocalMcpClient(async (client) => {
    const tools = await client.tools({
      schemas: {
        [SEND_DEVICE_COMMANDS_TOOL_NAME]: {
          inputSchema: SendCommandsSchema,
        },
      },
    });
    const tool = tools[SEND_DEVICE_COMMANDS_TOOL_NAME];
    const output = await tool.execute(input, {
      toolCallId: `local_${crypto.randomUUID()}`,
      messages: [],
    });
    return normalizeSendCommandsToolResult(output, input.request_id);
  });
}

export async function withLocalMcpClient<T>(run: (client: MCPClient) => Promise<T>): Promise<T> {
  const headers = localMcpAuthHeaders();
  const client = await createMCPClient({
    transport: {
      type: "http",
      url: localMcpUrl(),
      ...(headers ? { headers } : {}),
      redirect: "error",
      fetch: localMcpFetch as typeof fetch,
    },
  });
  try {
    return await run(client);
  } finally {
    await client.close().catch(() => {});
  }
}

function normalizeSendCommandsToolResult(output: unknown, fallbackRequestId: string | undefined): McpSendDeviceCommandsResult {
  const structured = structuredContent(output);
  if (structured.ok === false) {
    throw new Error(typeof structured.error === "string" ? structured.error : "mcp_tool_failed");
  }
  const commands = Array.isArray(structured.commands) ? structured.commands : [];
  const requestId = typeof structured.request_id === "string"
    ? structured.request_id
    : fallbackRequestId || "";
  return {
    ...structured,
    request_id: requestId,
    commands,
  };
}

function structuredContent(output: unknown): Record<string, unknown> {
  const body = objectRecord(output);
  if (!body) throw new Error("mcp_tool_result_invalid");
  const structured = objectRecord(body.structuredContent);
  if (structured) return structured;

  const toolResult = objectRecord(body.toolResult);
  if (toolResult) return toolResult;

  const text = Array.isArray(body.content)
    ? body.content
      .map((item) => objectRecord(item))
      .find((item) => item?.type === "text" && typeof item.text === "string")
      ?.text as string | undefined
    : undefined;
  if (text) {
    try {
      const parsed = JSON.parse(text);
      const parsedRecord = objectRecord(parsed);
      if (parsedRecord) return parsedRecord;
    } catch {
      // Fall through to a stable error below.
    }
  }
  throw new Error("mcp_tool_result_invalid");
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function localMcpFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  const { handleMcpRequest } = await import("../routes/mcp");
  const request = requestFromFetchArgs(input, init);
  return handleMcpRequest(request, { remoteAddress: MCP_HOST });
}

function requestFromFetchArgs(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Request {
  if (input instanceof Request && !init) return input;
  if (input instanceof Request) return new Request(input, init);
  if (input instanceof URL) return new Request(input.toString(), init);
  return new Request(input, init);
}

function localMcpUrl(): string {
  return `http://${MCP_HOST}:${localMcpPort()}/api/mcp`;
}

function localMcpPort(): number {
  const raw = process.env.MCP_PORT || "";
  if (!raw) return DEFAULT_MCP_PORT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535
    ? parsed
    : DEFAULT_MCP_PORT;
}

function localMcpAuthHeaders(): Record<string, string> | undefined {
  const token = process.env.MCP_SERVER_TOKEN || process.env.MCP_ADMIN_TOKEN || "";
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}
