import { handleMcpRequest } from "../routes/mcp";

const DEFAULT_MCP_PORT = 3031;
const DEFAULT_MCP_HOST = "127.0.0.1";

export function startLocalMcpServer(): { port: number; url: string; enabled: boolean } {
  const port = localMcpPort();
  const host = localMcpHost();
  try {
    let server: ReturnType<typeof Bun.serve> | null = null;
    server = Bun.serve({
      hostname: host,
      port,
      fetch(req): Response | Promise<Response> {
        const url = new URL(req.url);
        if (url.pathname !== "/api/mcp") {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        return handleMcpRequest(req, {
          remoteAddress: server?.requestIP(req)?.address ?? null,
          localListener: true,
        });
      },
    });
    const boundPort = server.port ?? port;
    const url = `http://${host}:${boundPort}/api/mcp`;
    console.log(`[mcp] Local MCP server listening on ${url}`);
    return { port: boundPort, url, enabled: true };
  } catch (error) {
    console.warn("[mcp] Local MCP server not started:", error instanceof Error ? error.message : String(error));
    return { port, url: `http://${host}:${port}/api/mcp`, enabled: false };
  }
}

function localMcpPort(): number {
  const raw = process.env.MCP_PORT || "";
  if (!raw) return DEFAULT_MCP_PORT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535
    ? parsed
    : DEFAULT_MCP_PORT;
}

function localMcpHost(): string {
  const raw = (process.env.MCP_HOST || "").trim();
  if (!raw) return DEFAULT_MCP_HOST;
  return raw === "0.0.0.0" || raw === "::" || raw === "127.0.0.1" || raw === "::1"
    ? raw
    : DEFAULT_MCP_HOST;
}
