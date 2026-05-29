import { resolve, normalize, relative, sep } from "node:path";
import { realpathSync } from "node:fs";
import { realpath as realpathAsync } from "node:fs/promises";
import { handleReport } from "./routes/report";
import { handleCurrent } from "./routes/current";
import { handleTimeline } from "./routes/timeline";
import { handleHealth } from "./routes/health";
import { handleHealthData, handleHealthDataQuery } from "./routes/health-data";
import { handleHealthWebhook } from "./routes/health-webhook";
import { handleConfig } from "./routes/config";
import { handleDailySummary } from "./routes/daily-summary";
import { handleLocationQuery } from "./routes/location";
import { handleViewerTokenIssue, handlePowChallenge } from "./routes/viewer-token";
import {
  getWsInfo,
  handleBlockViewer,
  handleUnblockViewer,
  handleDeviceMessageHistory,
  handleDeviceMessages,
  handleDeviceMessageReply,
  handleDeleteMessage,
  handleSetRemark,
  handlePublicMessages,
  realtimeWebSocket,
  type WsData,
  handleDeleteDevice,
  globalIpRateLimit,
} from "./services/realtime";
import { currentHourWindow, withCdnHeaders } from "./services/cdn";
import { injectSiteConfig } from "./services/site-config";

// Start scheduled cleanup tasks (import triggers setInterval registration)
import "./services/cleanup";

const PORT = parseInt(process.env.PORT || "3000", 10);
if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`[server] Invalid PORT: ${process.env.PORT}, using 3000`);
}
const LISTEN_PORT = isNaN(PORT) || PORT < 1 || PORT > 65535 ? 3000 : PORT;

const STATIC_ROOT = resolve(process.env.STATIC_DIR || "./public");

// Cache realpath of static root at startup (avoids per-request sync IO)
let REAL_STATIC_ROOT = "";
let staticEnabled = false;
try {
  REAL_STATIC_ROOT = realpathSync(STATIC_ROOT);
  staticEnabled = true;
} catch {
  console.warn(`[server] Static dir not found: ${STATIC_ROOT} — static files won't be served`);
}

async function serveStaticFile(realFile: string): Promise<Response> {
  if (realFile.endsWith(".html")) {
    const html = await Bun.file(realFile).text();
    return new Response(injectSiteConfig(html), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return new Response(Bun.file(realFile));
}

const server = Bun.serve<WsData>({
  port: LISTEN_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    // Reject direct IP access (only allow localhost and domain-based access)
    const host = req.headers.get("host") || "";
    const isLocalhost = host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]");
    const isDirectIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(host);
    if (isDirectIp && !isLocalhost) {
      return Response.json({ error: "Direct IP access not allowed" }, { status: 403 });
    }

    // CORS headers: public endpoints allow wildcard, sensitive endpoints require explicit origins
    const isPublicEndpoint = pathname === "/api/current" ||
      pathname === "/api/timeline" ||
      pathname === "/api/health" ||
      pathname === "/api/daily-summary" ||
      pathname === "/api/config" ||
      pathname === "/api/messages/public";
    
    const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS?.split(",").map(s => s.trim()).filter(Boolean) || [];
    const requestOrigin = req.headers.get("origin");
    
    let corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    
    if (isPublicEndpoint) {
      corsHeaders["Access-Control-Allow-Origin"] = "*";
    } else if (allowedOrigins.length > 0 && requestOrigin && allowedOrigins.includes(requestOrigin)) {
      corsHeaders["Access-Control-Allow-Origin"] = requestOrigin;
    } else if (allowedOrigins.length === 0 && isPublicEndpoint) {
      corsHeaders["Access-Control-Allow-Origin"] = "*";
    } else {
      // No allowlist for write endpoints — deny cross-origin
    }

    // Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Global IP rate limiting — skip for device-authenticated requests
    const clientIpForRate =
      req.headers.get("x-real-ip") ||
      req.headers.get("cf-connecting-ip") ||
      server.requestIP(req)?.address ||
      "unknown";
    const authHeader = req.headers.get("authorization") || "";
    // Real device token check: verify against known tokens (not just string length)
    const deviceTokens = (process.env.DEVICE_TOKEN_1 + "," + (process.env.DEVICE_TOKEN_2 || "")).split(",").filter(Boolean);
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    const hasDeviceToken = bearerToken.length > 0 && deviceTokens.includes(bearerToken);
    if (!hasDeviceToken && !globalIpRateLimit(clientIpForRate)) {
      return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    }

    // Request body size limit (1MB) — prevents memory exhaustion
    if (req.method === "POST" || req.method === "PUT" || req.method === "DELETE") {
      const contentLength = parseInt(req.headers.get("content-length") || "0", 10);
      if (contentLength > 1024 * 1024) {
        return Response.json({ error: "Payload too large" }, { status: 413 });
      }
    }

    // API routes
    let response: Response;

    try {
      const clientIp =
        req.headers.get("x-real-ip") ||
        req.headers.get("cf-connecting-ip") ||
        server.requestIP(req)?.address ||
        "";
      if (pathname === "/api/ws") {
        const wsInfo = getWsInfo(req);
        if (wsInfo instanceof Response) return wsInfo;
        if (server.upgrade(req, { data: wsInfo })) {
          return undefined;
        }
        return Response.json({ error: "WebSocket upgrade failed" }, { status: 400 });
      } else if (pathname === "/api/report" && req.method === "POST") {
        response = await handleReport(req);
      } else if (pathname === "/api/current" && req.method === "GET") {
        response = handleCurrent(clientIp, req.headers.get("user-agent") || undefined);
        response = withCdnHeaders(response, ["current", `current-${currentHourWindow()}`], 5);
      } else if (pathname === "/api/timeline" && req.method === "GET") {
        response = handleTimeline(url);
      } else if (pathname === "/api/health" && req.method === "GET") {
        response = handleHealth();
      } else if (pathname === "/api/health-data" && req.method === "POST") {
        response = await handleHealthData(req);
      } else if (pathname === "/api/health-data" && req.method === "GET") {
        response = handleHealthDataQuery(url, req);
      } else if (pathname === "/api/health-webhook" && req.method === "POST") {
        response = await handleHealthWebhook(req);
      } else if (pathname === "/api/config" && req.method === "GET") {
        response = handleConfig();
      } else if (pathname === "/api/daily-summary" && req.method === "GET") {
        response = handleDailySummary(url);
      } else if (pathname === "/api/location" && req.method === "GET") {
        response = handleLocationQuery(url, req);
      } else if (pathname === "/api/messages" && req.method === "GET") {
        response = handleDeviceMessages(req);
      } else if (pathname === "/api/messages/history" && req.method === "GET") {
        response = handleDeviceMessageHistory(req);
      } else if (pathname === "/api/messages/reply" && req.method === "POST") {
        response = await handleDeviceMessageReply(req);
      } else if (pathname === "/api/messages/delete" && req.method === "POST") {
        response = await handleDeleteMessage(req);
      } else if (pathname === "/api/messages/remark" && req.method === "POST") {
        response = await handleSetRemark(req);
      } else if (pathname === "/api/messages/block" && req.method === "POST") {
        response = await handleBlockViewer(req);
      } else if (pathname === "/api/messages/unblock" && req.method === "POST") {
        response = await handleUnblockViewer(req);
      } else if (pathname === "/api/messages/public" && req.method === "GET") {
        response = handlePublicMessages(req);
      } else if (pathname === "/api/pow/challenge" && req.method === "GET") {
        response = handlePowChallenge(req, clientIp);
      } else if (pathname === "/api/token/issue" && req.method === "POST") {
        response = await handleViewerTokenIssue(req, clientIp);
      } else if (pathname === "/api/device" && req.method === "DELETE") {
        response = await handleDeleteDevice(req);
      } else if (!pathname.startsWith("/api/")) {
        // Static file serving disabled if directory doesn't exist
        if (!staticEnabled) {
          response = Response.json({ error: "Not found" }, { status: 404 });
        } else {
          // Path traversal + symlink protection
          let decoded: string;
          try {
            decoded = decodeURIComponent(pathname);
          } catch {
            return new Response("Bad request", { status: 400 });
          }
          const safePath = normalize(decoded).replace(/^(\.\.[\/\\])+/, "");
          const resolved = resolve(STATIC_ROOT, safePath.replace(/^[\/\\]+/, ""));

          // Quick check: relative path must not escape root
          const rel = relative(STATIC_ROOT, resolved);
          if (rel.startsWith("..")) {
            response = Response.json({ error: "Forbidden" }, { status: 403 });
          } else {
            // Resolve symlinks and verify the real path is under root, then serve
            try {
              const realFile = await realpathAsync(resolved);
              if (realFile !== REAL_STATIC_ROOT && !realFile.startsWith(REAL_STATIC_ROOT + sep)) {
                response = Response.json({ error: "Forbidden" }, { status: 403 });
              } else {
                // Serve from the resolved real path
                const file = Bun.file(realFile);
                if (await file.exists()) {
                  return serveStaticFile(realFile);
                }
                // SPA fallback: file not found (or is a directory), serve index.html
                const indexFile = Bun.file(`${REAL_STATIC_ROOT}/index.html`);
                if (await indexFile.exists()) {
                  return serveStaticFile(`${REAL_STATIC_ROOT}/index.html`);
                }
                response = Response.json({ error: "Not found" }, { status: 404 });
              }
            } catch {
              // realpath fails if file doesn't exist — try SPA fallback
              const indexFile = Bun.file(`${REAL_STATIC_ROOT}/index.html`);
              if (await indexFile.exists()) {
                return serveStaticFile(`${REAL_STATIC_ROOT}/index.html`);
              }
              response = Response.json({ error: "Not found" }, { status: 404 });
            }
          }
        }
      } else {
        response = Response.json({ error: "Not found" }, { status: 404 });
      }
    } catch (e) {
      console.error("[server] Unhandled error:", e);
      response = Response.json({ error: "Internal error" }, { status: 500 });
    }

    // Append CORS headers to API responses
    for (const [key, value] of Object.entries(corsHeaders)) {
      response.headers.set(key, value);
    }

    // Security headers
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("X-Frame-Options", "SAMEORIGIN");
    response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

    return response;
  },
  websocket: realtimeWebSocket,
});

console.log(`[server] Live Dashboard backend running on http://localhost:${server.port}`);
if (process.env.NSFW_FILTER_DISABLED === "true") {
  console.warn("[server] ⚠️  NSFW FILTER IS DISABLED — content filtering is OFF. Set NSFW_FILTER_DISABLED=false to re-enable.");
}
