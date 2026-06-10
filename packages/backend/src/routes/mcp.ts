import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createLiveDashboardMcpServer } from "../services/mcp-server";

const MCP_MAX_REQUEST_BYTES = 256 * 1024;

export async function handleMcpRequest(req: Request, options: { remoteAddress?: string | null } = {}): Promise<Response> {
  if (!isLocalMcpRequest(req, options.remoteAddress ?? null)) {
    return noStoreJson({ error: "local_mcp_only" }, 403);
  }
  if (!isAuthorizedMcpRequest(req)) {
    return noStoreJson({ error: "unauthorized" }, 401);
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: {
        "Allow": "POST",
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
  const contentLength = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MCP_MAX_REQUEST_BYTES) {
    return noStoreJson({ error: "request_too_large" }, 413);
  }

  const server = createLiveDashboardMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(req);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  } finally {
    await server.close().catch(() => {});
  }
}

export function isLocalMcpRequest(req: Request, remoteAddress?: string | null): boolean {
  if (remoteAddress) return isLoopbackAddress(remoteAddress);
  return false;
}

function isAuthorizedMcpRequest(req: Request): boolean {
  const token = mcpToken();
  if (!token) return true;
  const match = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return secureTokenEquals(match[1]!, token);
}

function mcpToken(): string {
  return process.env.MCP_SERVER_TOKEN || process.env.MCP_ADMIN_TOKEN || "";
}

function isLoopbackAddress(value: string): boolean {
  const address = value.trim().toLowerCase();
  if (address === "::1" || address === "0:0:0:0:0:0:0:1") return true;
  if (address.startsWith("::ffff:")) return isLoopbackIpv4(address.slice("::ffff:".length));
  return isLoopbackIpv4(address);
}

function isLoopbackIpv4(value: string): boolean {
  const match = value.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
  if (!match) return false;
  const parts = value.split(".").map((part) => Number.parseInt(part, 10));
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    parts[0] === 127;
}

function secureTokenEquals(left: string, right: string): boolean {
  const leftHash = sha256(left);
  const rightHash = sha256(right);
  return leftHash === rightHash;
}

function sha256(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

function noStoreJson(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
