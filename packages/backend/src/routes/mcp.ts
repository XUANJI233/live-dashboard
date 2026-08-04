import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createLiveDashboardMcpServer } from "../services/mcp-server";
import { readLimitedRequestText } from "../services/request-body";

const MCP_MAX_REQUEST_BYTES = 256 * 1024;

export async function handleMcpRequest(req: Request, options: {
  remoteAddress?: string | null;
  localListener?: boolean;
  publicEndpoint?: boolean;
  internalRequest?: boolean;
} = {}): Promise<Response> {
  const access = mcpAccess({
    remoteAddress: options.remoteAddress ?? null,
    localListener: options.localListener === true,
    publicEndpoint: options.publicEndpoint === true,
    internalRequest: options.internalRequest === true,
  });
  if (!access.allowed) {
    return noStoreJson({ error: access.error }, access.status);
  }
  if (!options.internalRequest) {
    const browserGuard = browserMcpGuard(req);
    if (!browserGuard.allowed) return noStoreJson({ error: browserGuard.error }, browserGuard.status);
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
  const body = await readLimitedRequestText(req, MCP_MAX_REQUEST_BYTES, { error: "request_too_large" });
  if (!body.ok) {
    return noStoreJson({ error: "request_too_large" }, 413);
  }

  const server = createLiveDashboardMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const headers = new Headers(req.headers);
    headers.delete("content-length");
    const boundedReq = new Request(req.url, {
      method: req.method,
      headers,
      body: body.text,
    });
    const response = await transport.handleRequest(boundedReq);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  } finally {
    await server.close().catch(() => {});
  }
}

export function isLocalMcpRequest(remoteAddress?: string | null): boolean {
  if (remoteAddress) return isLoopbackAddress(remoteAddress);
  return false;
}

export function isRemoteMcpEnabled(): boolean {
  return /^true$/i.test(process.env.MCP_REMOTE_ENABLED || "");
}

export function mcpRequiresEdgeBypass(): boolean {
  return isRemoteMcpEnabled() && !!mcpToken();
}

export function isLocalNetworkMcpEnabled(): boolean {
  return /^true$/i.test(process.env.MCP_LOCAL_NETWORK_ENABLED || "");
}

export function isLoopbackTokenlessMcpEnabled(): boolean {
  return /^true$/i.test(process.env.MCP_LOOPBACK_TOKENLESS_ENABLED || "");
}

function mcpAccess(input: {
  remoteAddress: string | null;
  localListener: boolean;
  publicEndpoint: boolean;
  internalRequest: boolean;
}): {
  allowed: boolean;
  error: string;
  status: number;
} {
  if (input.internalRequest) return { allowed: true, error: "", status: 200 };
  if (input.publicEndpoint) {
    if (!isRemoteMcpEnabled()) return { allowed: false, error: "remote_mcp_disabled", status: 403 };
    if (!mcpToken()) return { allowed: false, error: "remote_mcp_token_required", status: 403 };
    return { allowed: true, error: "", status: 200 };
  }
  if (input.localListener && isLocalMcpRequest(input.remoteAddress)) {
    if (!mcpToken() && !isLoopbackTokenlessMcpEnabled()) {
      return { allowed: false, error: "local_mcp_token_required", status: 403 };
    }
    return { allowed: true, error: "", status: 200 };
  }
  if (input.localListener && isLocalNetworkMcpEnabled()) {
    if (!mcpToken()) return { allowed: false, error: "local_network_mcp_token_required", status: 403 };
    return { allowed: true, error: "", status: 200 };
  }
  if (!isRemoteMcpEnabled()) return { allowed: false, error: "local_mcp_only", status: 403 };
  if (!mcpToken()) return { allowed: false, error: "remote_mcp_token_required", status: 403 };
  return { allowed: true, error: "", status: 200 };
}

function browserMcpGuard(req: Request): { allowed: boolean; error: string; status: number } {
  if (req.headers.get("origin")) return { allowed: false, error: "browser_origin_not_allowed", status: 403 };
  if (req.method === "POST") {
    if (!isJsonContentType(req.headers.get("content-type"))) {
      return { allowed: false, error: "invalid_content_type", status: 415 };
    }
  }
  return { allowed: true, error: "", status: 200 };
}

function isJsonContentType(value: string | null): boolean {
  const mediaType = (value || "").split(";", 1)[0]!.trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
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
