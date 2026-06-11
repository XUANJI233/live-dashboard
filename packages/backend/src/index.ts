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
import { handleSupervisionAck } from "./routes/supervision-ack";
import { authenticateToken } from "./middleware/auth";
import { handleAiJobQuery, handleAiJobSubmit } from "./routes/ai-jobs";
import {
  handleDailySummary,
  handleDailySummaryRefresh,
  handleAiConfig,
  handleAiConfigTest,
  handleAiConfigUpdate,
  handleSummarySettings,
  handleSummarySettingsUpdate,
  handleWeeklySummary,
  handleWeeklySummaryRefresh,
} from "./routes/daily-summary";
import { handleLocationQuery } from "./routes/location";
import { handleViewerTokenIssue, handlePowChallenge } from "./routes/viewer-token";
import { powChallengeRateLimit } from "./services/viewer-auth";
import {
  getWsInfo,
  realtimeWebSocket,
  type WsData,
  handleDeleteDevice,
} from "./services/realtime";
import {
  handleDeviceMessageReply,
  handlePublicMessagePost,
  handlePrivateMessagePost,
} from "./services/realtime-message-handlers";
import {
  handleBlockViewer,
  handleUnblockViewer,
  handleDeleteMessage,
  handleDeleteViewerMessages,
  handleSetRemark,
} from "./services/realtime-message-management-handlers";
import {
  handleDeviceMessageHistory,
  handleDeviceMessages,
  handlePublicMessages,
  handleViewerMessageHistory,
} from "./services/realtime-message-read-handlers";
import { globalIpRateLimit } from "./services/realtime-rate-limit";
import { noStore, withCdnHeaders } from "./services/cdn";
import { normalizeClientIp } from "./services/visitors";
import { getVapidKeys, saveSubscription, removeSubscription } from "./services/push";
import { verifyViewerToken, viewerTokenFromRequest } from "./services/viewer-auth";
import { injectSiteConfig } from "./services/site-config";
import { startLocalMcpServer } from "./services/mcp-local-server";
import { recoverInterruptedAiJobs } from "./services/ai-jobs";

// Start scheduled cleanup tasks (import triggers setInterval registration)
import "./services/cleanup";
recoverInterruptedAiJobs();

const PORT = parseInt(process.env.PORT || "3000", 10);
if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`[server] Invalid PORT: ${process.env.PORT}, using 3000`);
}
const LISTEN_PORT = isNaN(PORT) || PORT < 1 || PORT > 65535 ? 3000 : PORT;

const STATIC_ROOT = resolve(process.env.STATIC_DIR || "./public");

import { hmacTitle } from "./db";

const REQUIRE_EDGE = /^true$/i.test(process.env.REQUIRE_EDGE || "");

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
    return noStore(new Response(injectSiteConfig(html), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }), ["page", "page-index"]);
  }

  return withCdnHeaders(new Response(Bun.file(realFile)), staticCacheTags(realFile), 60 * 60 * 24 * 30);
}

function staticCacheTags(realFile: string): string[] {
  const rel = relative(REAL_STATIC_ROOT, realFile).replaceAll("\\", "/");
  const safe = rel.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return ["static", ...(safe ? [`static-${safe}`] : [])];
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

    // 边缘模式：只接受来自边缘函数的请求（健康检查和 OPTIONS 除外）
    // WS 排除：ESA CDN 可能剥离 upgrade 头，同时检查路径
    const isWs = req.headers.get("upgrade")?.toLowerCase() === "websocket" || pathname === "/api/ws";
    // 只对 API 路径检查边缘签名，静态文件不受影响
    const isApi = pathname.startsWith("/api/");
    if (REQUIRE_EDGE && isApi && pathname !== "/api/health" && req.method !== "OPTIONS" && !isWs) {
      const edgeSig = req.headers.get("x-edge-internal");
      if (!edgeSig) {
        return Response.json({ error: "必须通过边缘函数访问" }, { status: 403 });
      }
      const expected = hmacTitle("edge-internal");
      if (edgeSig !== expected) {
        return Response.json({ error: "边缘签名无效" }, { status: 403 });
      }
    }

    // CORS headers: public endpoints allow wildcard, sensitive endpoints require explicit origins
    const isPublicEndpoint = pathname === "/api/current" ||
      pathname === "/api/timeline" ||
      pathname === "/api/health" ||
      (pathname === "/api/daily-summary" && req.method === "GET") ||
      (pathname === "/api/weekly-summary" && req.method === "GET") ||
      pathname === "/api/config" ||
      pathname === "/api/push/vapid-public-key" ||
      (pathname === "/api/messages/public" && req.method === "GET") ||
      pathname === "/api/pow/challenge" ||
      pathname === "/api/token/issue" ||
      (pathname === "/api/health-data" && req.method === "GET") ||
      (pathname === "/api/location" && req.method === "GET");
    
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

    // Global IP rate limiting — skip for device-authenticated and public GET requests
    const clientIpForRate = normalizeClientIp(
      req.headers.get("ali-real-client-ip") ||
      req.headers.get("x-real-ip") ||
      req.headers.get("cf-connecting-ip") ||
      server.requestIP(req)?.address ||
      req.headers.get("x-forwarded-for") ||
      "unknown"
    );
    const authHeader = req.headers.get("authorization") || "";
    // Real device token check: use authenticateToken which properly parses token:device_id:name:platform format
    const hasDeviceToken = authenticateToken(authHeader) !== null;
    // Auth endpoints (PoW challenge, token issue) and viewer-token authenticated GET endpoints
    // should skip global IP rate limiting — they have their own rate limits or are auth flows
    const isAuthEndpoint = pathname === "/api/pow/challenge" || pathname === "/api/token/issue";
    const isViewerAuthGet = req.method === "GET" && (
      pathname === "/api/health-data" || pathname === "/api/location" || pathname === "/api/ws" || pathname === "/api/messages/viewer/history"
    );
    // Skip rate limit for: device tokens, public GET endpoints, auth endpoints, viewer-auth GETs
    // Public GETs get a softer limit: 30/min instead of 60/min
    if (!hasDeviceToken && !isAuthEndpoint && !isViewerAuthGet) {
      if (isPublicEndpoint && req.method === "GET") {
        if (!globalIpRateLimit(clientIpForRate)) {
          return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
        }
      } else if (!globalIpRateLimit(clientIpForRate)) {
        return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
      }
    }

    // PoW challenge endpoint: independent per-IP rate limit (30/min)
    // Prevents flood attacks that could exhaust memory via challenge generation
    if (pathname === "/api/pow/challenge" && req.method === "GET") {
      if (!powChallengeRateLimit(clientIpForRate)) {
        return Response.json({ error: "Too many PoW requests", retryAfter: 60 }, { status: 429 });
      }
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
      const clientIp = normalizeClientIp(
        req.headers.get("ali-real-client-ip") ||
        req.headers.get("x-real-ip") ||
        req.headers.get("cf-connecting-ip") ||
        server.requestIP(req)?.address ||
        req.headers.get("x-forwarded-for") ||
        ""
      );
      if (pathname === "/api/ws") {
        const wsInfo = await getWsInfo(req);
        if (wsInfo instanceof Response) return wsInfo;
        if (server.upgrade(req, { data: wsInfo })) {
          return undefined;
        }
        return Response.json({ error: "WebSocket upgrade failed" }, { status: 400 });
      } else if (pathname === "/api/report" && req.method === "POST") {
        response = await handleReport(req);
      } else if (pathname === "/api/supervision/ack" && req.method === "POST") {
        response = await handleSupervisionAck(req);
      } else if (pathname === "/api/current" && req.method === "GET") {
        response = handleCurrent(req, clientIp, req.headers.get("user-agent") || undefined);
        response = noStore(response, ["current", "realtime", "status"]);
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
      } else if (pathname === "/api/daily-summary" && req.method === "POST") {
        response = await handleDailySummaryRefresh(req, url);
      } else if (pathname === "/api/weekly-summary" && req.method === "GET") {
        response = handleWeeklySummary(url);
      } else if (pathname === "/api/weekly-summary" && req.method === "POST") {
        response = await handleWeeklySummaryRefresh(req, url);
      } else if (pathname === "/api/summary-settings" && req.method === "GET") {
        response = handleSummarySettings(req);
      } else if (pathname === "/api/summary-settings" && req.method === "POST") {
        response = await handleSummarySettingsUpdate(req);
      } else if (pathname === "/api/ai-config" && req.method === "GET") {
        response = await handleAiConfig(req);
      } else if (pathname === "/api/ai-config" && req.method === "POST") {
        response = await handleAiConfigUpdate(req);
      } else if (pathname === "/api/ai-config/test" && req.method === "POST") {
        response = await handleAiConfigTest(req);
      } else if (pathname === "/api/ai-jobs" && req.method === "POST") {
        response = await handleAiJobSubmit(req);
      } else if (pathname === "/api/ai-jobs" && req.method === "GET") {
        response = handleAiJobQuery(req, url);
      } else if (pathname === "/api/location" && req.method === "GET") {
        response = handleLocationQuery(url, req);
      } else if (pathname === "/api/messages" && req.method === "GET") {
        response = handleDeviceMessages(req);
      } else if (pathname === "/api/messages/history" && req.method === "GET") {
        response = handleDeviceMessageHistory(req);
      } else if (pathname === "/api/messages/viewer/history" && req.method === "GET") {
        response = handleViewerMessageHistory(req);
      } else if (pathname === "/api/messages/reply" && req.method === "POST") {
        response = await handleDeviceMessageReply(req);
      } else if (pathname === "/api/messages/delete" && req.method === "POST") {
        response = await handleDeleteMessage(req);
      } else if (pathname === "/api/messages/viewer/delete" && req.method === "POST") {
        response = await handleDeleteViewerMessages(req);
      } else if (pathname === "/api/messages/remark" && req.method === "POST") {
        response = await handleSetRemark(req);
      } else if (pathname === "/api/messages/block" && req.method === "POST") {
        response = await handleBlockViewer(req);
      } else if (pathname === "/api/messages/unblock" && req.method === "POST") {
        response = await handleUnblockViewer(req);
      } else if (pathname === "/api/messages/public" && req.method === "GET") {
        response = handlePublicMessages(req);
      } else if (pathname === "/api/messages/public" && req.method === "POST") {
        response = await handlePublicMessagePost(req);
      } else if (pathname === "/api/messages/private" && req.method === "POST") {
        response = await handlePrivateMessagePost(req);
      } else if (pathname === "/api/pow/challenge" && req.method === "GET") {
        response = handlePowChallenge(req, clientIp);
      } else if (pathname === "/api/token/issue" && req.method === "POST") {
        response = await handleViewerTokenIssue(req, clientIp);
      } else if (pathname === "/api/device" && req.method === "DELETE") {
        response = await handleDeleteDevice(req);
      } else if (pathname === "/api/push/vapid-public-key" && req.method === "GET") {
        response = Response.json({ publicKey: getVapidKeys().publicKey });
      } else if (pathname === "/api/push/subscribe" && req.method === "POST") {
        const viewer = verifyViewerToken(viewerTokenFromRequest(req));
        if (!viewer) response = Response.json({ error: "Viewer token required" }, { status: 403 });
        else {
          const body = await req.json().catch(() => null);
          if (isPushSubscriptionBody(body)) {
            saveSubscription(viewer.viewerId, body);
            response = Response.json({ ok: true });
          } else {
            response = Response.json({ error: "subscription required" }, { status: 400 });
          }
        }
      } else if (pathname === "/api/push/unsubscribe" && req.method === "POST") {
        const viewer = verifyViewerToken(viewerTokenFromRequest(req));
        if (!viewer) response = Response.json({ error: "Viewer token required" }, { status: 403 });
        else {
          removeSubscription(viewer.viewerId);
          response = Response.json({ ok: true });
        }
      } else if (!pathname.startsWith("/api/")) {
        // Static file serving disabled if directory doesn't exist
        if (!staticEnabled) {
          response = Response.json({ error: "Not found" }, { status: 404 });
        } else {
          if (pathname === "/favicon.ico") {
            const iconFile = Bun.file(`${REAL_STATIC_ROOT}/icon.svg`);
            if (await iconFile.exists()) {
              return noStore(new Response(null, {
                status: 302,
                headers: { Location: "/icon.svg" },
              }), ["static", "static-favicon-ico", "static-icon-svg"]);
            }
          }

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

const localMcpServer = startLocalMcpServer();

function isPushSubscriptionBody(value: unknown): value is { endpoint: string; keys: { p256dh: string; auth: string } } {
  if (!value || typeof value !== "object") return false;
  const body = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  return typeof body.endpoint === "string" &&
    !!body.keys &&
    typeof body.keys.p256dh === "string" &&
    typeof body.keys.auth === "string";
}

// ── 启动信息 ──
const edgeMode = /^true$/i.test(process.env.EDGE_MODE || "");
const nsfwDisabled = process.env.NSFW_FILTER_DISABLED === "true";
const messageBoard = process.env.MESSAGE_BOARD_ENABLED !== "false";
const privateChat = process.env.PRIVATE_CHAT_ENABLED !== "false";
const aiEnabled = !!(process.env.AI_API_URL && process.env.AI_API_KEY);
const aiModel = process.env.AI_MODEL || "";
const corsOrigins = process.env.CORS_ALLOWED_ORIGINS?.split(",").filter(Boolean).length || 0;
const displayName = process.env.DISPLAY_NAME || "";
const siteTitle = process.env.SITE_TITLE || "";
const dbPath = process.env.DB_PATH || "./data.db";

// 终端颜色
const Y = "\x1b[33m"; // 黄色
const G = "\x1b[32m"; // 绿色
const RD = "\x1b[31m"; // 红色
const R = "\x1b[0m";  // 重置
const DIM = "\x1b[2m"; // 暗色

// 计算字符串在终端的显示宽度（中文=2，ASCII=1）
function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    w += (code > 0x7F && code < 0x10000) ? 2 : 1;
  }
  return w;
}

// 右侧补空格到指定显示宽度
function padR(s: string, target: number): string {
  return s + " ".repeat(Math.max(0, target - strWidth(s)));
}

const W = 40; // 内容区宽度
const line = (label: string, value: string, color = "") =>
  `  │ ${color}${padR(label + value, W)}${color ? R : ""}│`;

const powDisabled = /^(1|true|yes)$/i.test(process.env.POW_DISABLED || "");
const tlsCheckDisabled = /^(1|true|yes)$/i.test(process.env.TLS_CHECK_DISABLED || "");
const hashSecretLen = (process.env.HASH_SECRET || "").length;

console.log("");
console.log("  ╭" + "─".repeat(W + 2) + "╮");
console.log("  │" + padR("  Live Dashboard 启动", W + 2) + "│");
console.log("  ├" + "─".repeat(W + 2) + "┤");
console.log(line("地址:     ", `http://localhost:${server.port}`));
if (siteTitle) console.log(line("站点:     ", siteTitle));
console.log(line("边缘函数: ", edgeMode ? `${G}信任签名请求${R}` : "关闭"));
console.log(line("强制边缘: ", REQUIRE_EDGE ? `${G}开启${R}` : "关闭"));
console.log(line("数据库:   ", dbPath));
console.log(line("静态文件: ", staticEnabled ? "已加载" : `${Y}未找到${R}`));
console.log("  ├" + "─".repeat(W + 2) + "┤");
console.log(line("留言板:   ", messageBoard ? "开启" : "关闭"));
console.log(line("私聊:     ", privateChat ? "开启" : "关闭"));
console.log(line("AI 总结:  ", aiEnabled ? "开启" : "关闭"));
if (aiEnabled && aiModel) console.log(line("AI 模型:  ", aiModel));
console.log(line("NSFW 过滤:", nsfwDisabled ? `${Y}已关闭${R}` : "开启"));
console.log(line("PoW 验证: ", powDisabled ? `${RD}已关闭${R}` : "开启"));
console.log(line("TLS 检查: ", tlsCheckDisabled ? `${RD}已关闭${R}` : "开启"));
console.log(line("CORS:     ", corsOrigins ? `${corsOrigins} 个域名` : "仅同源"));
console.log(line("密钥:     ", hashSecretLen >= 64 ? `${G}已配置 (${hashSecretLen} 位)${R}` : hashSecretLen > 0 ? `${Y}较短 (${hashSecretLen} 位)${R}` : `${RD}未设置${R}`));
if (displayName) console.log(line("显示名:   ", displayName));
console.log("  ╰" + "─".repeat(W + 2) + "╯");

const validPlatforms = new Set(["windows", "android", "macos", "zepp"]);
// 设备令牌汇总
const envTokens = Object.entries(process.env).filter(([k]) => k.startsWith("DEVICE_TOKEN_") && k.match(/^DEVICE_TOKEN_\d+$/));
let loadedCount = 0;
let invalidCount = 0;
const deviceNames: string[] = [];
for (const [key, value] of envTokens) {
  if (!value) continue;
  const parts = value.split(":");
  if (parts.length < 4) {
    invalidCount++;
    console.log(`  ${RD}✗ ${key}: 格式错误，需要 密钥:设备ID:显示名:平台${R}`);
  } else {
    const platform = parts[parts.length - 1];
    const deviceName = parts.slice(2, -1).join(":");
    if (!platform || !validPlatforms.has(platform)) {
      invalidCount++;
      console.log(`  ${RD}✗ ${key}: 平台 "${platform}" 无效，必须是 windows/android/macos/zepp${R}`);
    } else {
      loadedCount++;
      deviceNames.push(`${deviceName} (${platform})`);
    }
  }
}
if (envTokens.length > 0) {
  console.log(`  设备令牌: ${G}${loadedCount} 个已加载${R}${invalidCount > 0 ? `，${RD}${invalidCount} 个错误${R}` : ""}`);
  for (const name of deviceNames) {
    console.log(`  ${DIM}  └─ ${name}${R}`);
  }
} else {
  console.log(`  ${RD}✗ 未配置设备令牌，Agent 无法连接${R}`);
}

// 修复建议
const tips: string[] = [];
if (hashSecretLen === 0) tips.push("HASH_SECRET 未设置，服务无法启动");
if (hashSecretLen > 0 && hashSecretLen < 64) tips.push("HASH_SECRET 较短，建议使用 openssl rand -hex 32 生成");
if (!displayName) tips.push("设置 DISPLAY_NAME 自定义显示名称");
if (nsfwDisabled) tips.push("NSFW 过滤已关闭，敏感内容将直接显示");
if (REQUIRE_EDGE && !edgeMode) tips.push("REQUIRE_EDGE 已开启，建议同时设置 EDGE_MODE=true 信任边缘已验证请求");
if (invalidCount > 0) tips.push("检查 DEVICE_TOKEN 格式: 密钥:设备ID:显示名:平台");
if (powDisabled) tips.push("PoW 验证已关闭，任何人都可以获取访客令牌");
if (tlsCheckDisabled) tips.push("TLS 检查已关闭，机器人请求不会被拦截");
if (tips.length > 0) {
  console.log("");
  for (const tip of tips) {
    const isDanger = tip.includes("已关闭") || tip.includes("格式错误") || tip.includes("未设置");
    const isWarn = tip.includes("较短") || tip.includes("CDN");
    const color = isDanger ? RD : isWarn ? Y : Y;
    console.log(`  ${color}💡 ${tip}${R}`);
  }
}
console.log("");
