/**
 * ESA Edge Function — Live Dashboard 边缘计算层
 *
 * 配置存储在 EdgeKV namespace "live-dashboard-config"：
 *   key "origin" → 源站地址 (如 https://live.myallinone.online)
 *   key "secret" → HMAC 密钥 (与源站 HASH_SECRET 一致)
 *   key "device_tokens" → 可选，设备密钥白名单，逗号/空白分隔
 *   key "device_token_hashes" → 可选，HMAC(secret, "device:" + token) 白名单
 *
 * 部署前至少在 EdgeKV 控制台写入 origin 和 secret。
 */

// ── 常量 ──
const CONFIG_NS = "live-dashboard-config";
const CACHE_TTL = { config: 60, publicMessages: 10, health: 5 };
const POW_DIFFICULTY = 4;
const POW_MEMORY_SEGMENTS = 16384; // 16K × 32 bytes = 512 KB memory requirement
const POW_CHALLENGE_TTL = 300;
const RATE_WINDOW = 60;
const RATE_GLOBAL = 300;
const RATE_POW = 30;
const RATE_ISSUE = 12;
const RATE_VIEWER = 60;

// 超时包装（ESA 推荐模式）
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// ── 配置加载 ──
async function loadConfig() {
  const kv = new EdgeKV({ namespace: CONFIG_NS });
  const [origin, secret, deviceTokens, deviceTokenHashes] = await Promise.all([
    withTimeout(kv.get("origin", { type: "text" }), 2000, ""),
    withTimeout(kv.get("secret", { type: "text" }), 2000, ""),
    withTimeout(kv.get("device_tokens", { type: "text" }), 2000, ""),
    withTimeout(kv.get("device_token_hashes", { type: "text" }), 2000, ""),
  ]);
  return {
    origin: origin || "",
    secret: secret || "",
    deviceTokens: deviceTokens || "",
    deviceTokenHashes: deviceTokenHashes || "",
  };
}

// ══════════════════════════════════════════════════════════════
export default {
  async fetch(request) {
    const cfg = await loadConfig();
    const { origin, secret, deviceTokens, deviceTokenHashes } = cfg;
    if (!origin) return new Response("边缘配置缺失：请在 EdgeKV 写入 origin", { status: 500 });

    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;
    const clientIp = request.headers.get("x-real-ip") ||
                     request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

    // CORS 预检
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // 内部请求旁路（HMAC 签名验证，防伪造）
    const internalSig = request.headers.get("x-edge-internal");
    if (internalSig && secret) {
      if (internalSig === await hmacHex(secret, "edge-internal")) {
        return passthrough(request, origin, clientIp);
      }
    }

    try {
      // 可信设备请求直接签名回源。放在边缘限流和访客鉴权前，避免管理员设备被误限或误判为 viewer token。
      const isTrustedDevice = await isDeviceTokenRequest(request, secret, deviceTokens, deviceTokenHashes);
      if (isTrustedDevice && isDeviceEndpoint(pathname)) {
        return passthroughSigned(request, origin, clientIp, secret);
      }

      // 全局 IP 限流
      if (clientIp !== "unknown" && !isTrustedDevice) {
        const kv = getEdgeKV();
        if (kv) {
          const count = await kvGetNumber(kv, `g:${clientIp}`);
          if (count >= RATE_GLOBAL) return jsonResponse({ error: "限流", retryAfter: 60 }, 429);
          kvPut(kv, `g:${clientIp}`, String((count || 0) + 1), RATE_WINDOW);
        }
      }

      // PoW 挑战 — 完全边缘处理
      if (pathname === "/api/pow/challenge" && method === "GET") {
        const powResp = await handlePowChallenge(clientIp, secret);
        if (powResp) return powResp;
        return passthroughSigned(request, origin, clientIp, secret);
      }

      // Token 签发 — 边缘验证 PoW + 签发
      if (pathname === "/api/token/issue" && method === "POST") {
        const tokenResp = await handleTokenIssue(request, clientIp, secret);
        if (tokenResp) return tokenResp;
        return passthroughSigned(request, origin, clientIp, secret);
      }

      // 由边缘统一管理缓存头/标签的读取。ttl=0 也会经过这里，以便强制 no-store 并补齐 Cache-Tag。
      const cacheMeta = getCacheMeta(pathname, request);
      if (method === "GET" && (cacheMeta.ttl > 0 || cacheMeta.tags?.length)) {
        return handleCachedRead(request, origin, pathname, secret, cacheMeta);
      }

      // WebSocket — 穿透前验证 token，拒绝无效连接节省源站资源
      if (pathname === "/api/ws") {
        const auth = request.headers.get("authorization") || "";
        const role = url.searchParams.get("role") || "";
        // Device token: check whitelist at edge
        if (role === "device") {
          if (await isDeviceTokenRequest(request, secret, deviceTokens, deviceTokenHashes)) {
            return passthrough(request, origin, clientIp);
          }
          return jsonResponse({ error: "无效的设备令牌" }, 403);
        }
        // Viewer token: verify at edge
        if (role === "viewer") {
          const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
          if (token && token.length > 20) {
            return passthrough(request, origin, clientIp); // origin validates full JWT
          }
          return jsonResponse({ error: "需要访客令牌" }, 403);
        }
        return jsonResponse({ error: "需要 role 参数 (device/viewer)" }, 400);
      }

      // 访客写入端点在边缘先验 token 和限流，挡掉无效脚本请求再回源。
      if (method === "POST" && isViewerWriteEndpoint(pathname)) {
        return handleAuthenticatedRequest(request, origin, clientIp, secret);
      }

      // 需要 token 的端点 — 边缘验证后穿透
      if (method === "GET" && isAuthEndpoint(pathname)) {
        return handleAuthenticatedRequest(request, origin, clientIp, secret);
      }

      // 其他 — 穿透
      return applySecurityHeaders(await passthroughSigned(request, origin, clientIp, secret));
    } catch {
      return applySecurityHeaders(await passthroughSigned(request, origin, clientIp, secret));
    }
  },
};

// ══════════════════════════════════════════════════════════════
// PoW 挑战
// ══════════════════════════════════════════════════════════════

async function handlePowChallenge(clientIp, secret) {
  if (!clientIp || clientIp === "unknown" || isLocalIp(clientIp)) {
    return jsonResponse({ skip: true, message: "本地 IP 无需 PoW" });
  }
  const kv = getEdgeKV();
  if (!kv) return null; // caller will fallback to passthrough

  // 限流 30/min
  const rate = await kvGetNumber(kv, `pr:${clientIp}`);
  if (rate >= RATE_POW) return jsonResponse({ error: "PoW 请求过多", retryAfter: 60 }, 429);
  kvPut(kv, `pr:${clientIp}`, String((rate || 0) + 1), RATE_WINDOW);

  // 生成挑战（内存密集型 PoW：客户端需分配 POW_MEMORY_SEGMENTS × 32B = 512KB）
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const challenge = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");

  // 存储到 KV（含难度和内存参数）
  await kvPutJson(kv, `pc:${challenge}`, {
    ip: clientIp, ipUpdated: false, createdAt: Date.now(),
    difficulty: POW_DIFFICULTY, segments: POW_MEMORY_SEGMENTS,
  }, POW_CHALLENGE_TTL);

  return noStoreJson({
    challenge, difficulty: POW_DIFFICULTY,
    segments: POW_MEMORY_SEGMENTS, expiresIn: POW_CHALLENGE_TTL,
  });
}

// ══════════════════════════════════════════════════════════════
// Token 签发
// ══════════════════════════════════════════════════════════════

async function handleTokenIssue(request, clientIp, secret) {
  if (!secret) return null; // 回源

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "无效 JSON" }, 400); }

  const { fingerprint, pow_challenge, pow_result } = body;
  if (!fingerprint || typeof fingerprint !== "string") return jsonResponse({ error: "需要 fingerprint" }, 400);

  // 限流 12/min
  const kv = getEdgeKV();
  if (kv) {
    const rate = await kvGetNumber(kv, `ir:${clientIp}`);
    if (rate >= RATE_ISSUE) return jsonResponse({ error: "限流" }, 429);
    kvPut(kv, `ir:${clientIp}`, String((rate || 0) + 1), RATE_WINDOW);
  }

  // PoW 验证
  const ipKnown = clientIp && clientIp !== "unknown";
  if (ipKnown && !isLocalIp(clientIp)) {
    if (!pow_challenge || !pow_result) return jsonResponse({ error: "需要 PoW", code: "POW_REQUIRED" }, 403);

    const challengeData = kv ? await kvGetJson(kv, `pc:${pow_challenge}`) : null;
    if (!challengeData) return jsonResponse({ error: "PoW 无效或过期", code: "POW_INVALID" }, 403);

    // IP 绑定（允许一次变更）
    if (challengeData.ip !== clientIp) {
      if (challengeData.ipUpdated) { if (kv) await kvDelete(kv, `pc:${pow_challenge}`); return jsonResponse({ error: "PoW IP 不匹配" }, 403); }
      challengeData.ipUpdated = true;
    }

    // Parse pow_result JSON
    let powResult;
    try { powResult = JSON.parse(pow_result); } catch { return jsonResponse({ error: "PoW 格式无效" }, 403); }

    // 验证内存密集型 PoW：客户端需填充 POW_MEMORY_SEGMENTS 个连续 SHA-256 哈希
    const segments = challengeData.segments || POW_MEMORY_SEGMENTS;
    const powResult = body.pow_result; // client submits: { nonce, lastHash }
    if (!powResult?.nonce || !powResult?.lastHash) {
      return jsonResponse({ error: "需要完整 PoW 结果 (nonce + lastHash)", code: "POW_INCOMPLETE" }, 403);
    }

    // 服务端重新计算内存链的最后一个哈希（16K × SHA-256 ≈ 3ms）
    const firstHash = await sha256Hex(pow_challenge);
    let chainHash = firstHash;
    for (let i = 1; i < segments; i++) {
      chainHash = await sha256Hex(chainHash);
    }
    if (chainHash !== powResult.lastHash) {
      return jsonResponse({ error: "PoW 内存链不匹配", code: "POW_CHAIN_MISMATCH" }, 403);
    }

    // 验证最终 nonce
    const finalInput = firstHash + chainHash + powResult.nonce;
    const finalHash = await sha256Hex(finalInput);
    const difficulty = challengeData.difficulty || POW_DIFFICULTY;
    if (!finalHash.startsWith("0".repeat(difficulty))) return jsonResponse({ error: "PoW 解无效" }, 403);

    if (kv) await kvDelete(kv, `pc:${pow_challenge}`);
  }

  // 签发 token
  const fp = fingerprint.replace(/[^a-zA-Z0-9:_.,| -]/g, "").trim().slice(0, 512);
  if (fp.length < 32 || new Set(fp).size < 6) return jsonResponse({ error: "fingerprint 太弱" }, 400);

  const viewerId = await resolveViewerId(secret, fp, clientIp);
  const ipHash = (ipKnown && clientIp !== "unknown") ? (await hmacHex(secret, "ip:" + clientIp)).slice(0, 16) : "";
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ sub: viewerId, ip: ipHash, iat: nowSec, exp: nowSec + 3600 });
  const encoded = btoa(payload).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const signature = await hmacSign(secret, encoded);

  return noStoreJson({ token: `${encoded}.${signature}`, viewer_id: viewerId, expires_in: 3600 });
}

async function resolveViewerId(secret, fingerprint, clientIp) {
  const fpId = `fp_${await hmacHex(secret, fingerprint)}`.slice(0, 35);
  const ipKnown = clientIp && clientIp !== "unknown";
  const ih = ipKnown ? (await hmacHex(secret, "ip:" + clientIp)).slice(0, 16) : "";
  const kv = getEdgeKV();
  if (!kv) return fpId;

  const fpViewer = await kvGetText(kv, `vf:${fpId}`);
  const ipViewer = ih ? await kvGetText(kv, `vi:${ih}`) : "";
  let viewerId = sanitizeViewerId(fpViewer) || sanitizeViewerId(ipViewer) || fpId;
  if (fpViewer && ipViewer && fpViewer !== ipViewer) {
    const canonical = fpViewer < ipViewer ? fpViewer : ipViewer;
    const alias = canonical === fpViewer ? ipViewer : fpViewer;
    viewerId = sanitizeViewerId(canonical) || viewerId;
    await kvPutText(kv, `va:${alias}`, viewerId);
  }
  await kvPutText(kv, `vf:${fpId}`, viewerId);
  if (ih) await kvPutText(kv, `vi:${ih}`, viewerId);
  return viewerId;
}

async function resolveViewerAlias(viewerId) {
  const clean = sanitizeViewerId(viewerId);
  if (!clean) return viewerId;
  const kv = getEdgeKV();
  if (!kv) return clean;
  let current = clean;
  for (let i = 0; i < 4; i++) {
    const next = sanitizeViewerId(await kvGetText(kv, `va:${current}`));
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}

function sanitizeViewerId(value) {
  return typeof value === "string" && /^fp_[a-f0-9]{32}$/.test(value) ? value : "";
}

// ── 安全响应头（对所有响应生效）──
function applySecurityHeaders(response) {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.delete("Server");
  return response;
}
// ══════════════════════════════════════════════════════════════

async function handleCachedRead(request, origin, pathname, secret, cacheMeta = getCacheMeta(pathname, request)) {
  const ttl = cacheMeta.ttl;
  const cacheKey = `http://edge-cache${pathname}${new URL(request.url).search}`;
  let verified = null;
  if (isAuthEndpoint(pathname)) {
    const clientIp = request.headers.get("x-real-ip") ||
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";
    const token = extractViewerToken(request);
    verified = token && secret ? await verifyViewerToken(token, secret, clientIp) : null;
    if (!verified) return jsonResponse({ error: "需要 viewer token" }, 403);
    const kv = getEdgeKV();
    if (kv) {
      const rate = await kvGetNumber(kv, `vr:${verified.viewerId}`);
      if (rate >= RATE_VIEWER) return jsonResponse({ error: "限流" }, 429);
      kvPut(kv, `vr:${verified.viewerId}`, String((rate || 0) + 1), RATE_WINDOW);
    }
  }

  if (ttl > 0) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    } catch {}
  }

  const originHeaders = new Headers(request.headers);
  originHeaders.set("X-Forwarded-For", request.headers.get("x-real-ip") || "");
  originHeaders.set("X-Real-IP", request.headers.get("x-real-ip") || "");
  if (secret) originHeaders.set("X-Edge-Internal", await hmacHex(secret, "edge-internal"));
  if (verified && secret) {
    originHeaders.set("X-Edge-Verified", "true");
    originHeaders.set("X-Edge-Viewer-Id", verified.viewerId);
    originHeaders.set("X-Edge-Signature", await hmacHex(secret, "edge:" + verified.viewerId));
  }
  const originResp = await fetch(`${origin}${pathname}${new URL(request.url).search}`, {
    headers: originHeaders,
  });
  if (!originResp.ok) return originResp;

  const response = withEdgeCacheHeaders(originResp, cacheMeta, ttl > 0 ? "MISS" : "BYPASS");

  if (ttl > 0) {
    try { await cache.put(cacheKey, response.clone()); } catch {}
  }
  return response;
}

// ══════════════════════════════════════════════════════════════
// Token 验证 + 穿透
// ══════════════════════════════════════════════════════════════

async function handleAuthenticatedRequest(request, origin, clientIp, secret) {
  if (!secret) return passthroughSigned(request, origin, clientIp, secret);

  const token = extractViewerToken(request);
  if (token) {
    const verified = await verifyViewerToken(token, secret, clientIp);
    if (verified) {
      // 限流 60/min/viewer
      const kv = getEdgeKV();
      if (kv) {
        const rate = await kvGetNumber(kv, `vr:${verified.viewerId}`);
        if (rate >= RATE_VIEWER) return jsonResponse({ error: "限流" }, 429);
        kvPut(kv, `vr:${verified.viewerId}`, String((rate || 0) + 1), RATE_WINDOW);
      }

      const headers = new Headers(request.headers);
      headers.set("X-Edge-Verified", "true");
      headers.set("X-Edge-Viewer-Id", verified.viewerId);
      headers.set("X-Edge-Signature", await hmacHex(secret, "edge:" + verified.viewerId));
      headers.set("X-Real-IP", clientIp);
      headers.set("X-Edge-Internal", await hmacHex(secret, "edge-internal"));

        const resp = await fetch(`${origin}${getPath(request)}${new URL(request.url).search}`, {
        method: request.method, headers,
        body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
      });

      const cacheMeta = getCacheMeta(getPath(request), request);
      if (request.method === "GET" && resp.ok && cacheMeta.tags?.length) {
        return withEdgeCacheHeaders(resp, cacheMeta, "PASS");
      }
      return resp;
    }
    return jsonResponse({ error: "token 无效" }, 403);
  }

  const path = getPath(request);
  if (isAuthEndpoint(path)) {
    return jsonResponse({ error: "需要 viewer token" }, 403);
  }
  return passthroughSigned(request, origin, clientIp, secret);
}

// ══════════════════════════════════════════════════════════════
// 工具函数
// ══════════════════════════════════════════════════════════════

function getPath(request) { return new URL(request.url).pathname; }

function passthrough(request, origin, clientIp) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  if (clientIp) headers.set("X-Real-IP", clientIp);
  return fetch(`${origin}${url.pathname}${url.search}`, {
    method: request.method, headers,
    body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
  }).then(applySecurityHeaders);
}
async function passthroughSigned(request, origin, clientIp, secret) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  if (clientIp) headers.set("X-Real-IP", clientIp);
  if (secret) headers.set("X-Edge-Internal", await hmacHex(secret, "edge-internal"));
  return fetch(`${origin}${url.pathname}${url.search}`, {
    method: request.method, headers,
    body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
  });
}


function withEdgeCacheHeaders(response, cacheMeta, edgeState) {
  const headers = new Headers(response.headers);
  if (cacheMeta.tags?.length) {
    const tagHeader = cacheMeta.tags.join(",");
    headers.set("Cache-Tag", tagHeader);
    headers.set("ESA-Cache-Tag", tagHeader);
  }
  if (cacheMeta.ttl > 0) {
    headers.set("Cache-Control", `public, max-age=${cacheMeta.ttl}, s-maxage=${cacheMeta.ttl}, stale-while-revalidate=30`);
    headers.set("Expires", new Date(Date.now() + cacheMeta.ttl * 1000).toUTCString());
  } else {
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0, s-maxage=0");
    headers.set("Pragma", "no-cache");
    headers.set("Expires", "0");
    headers.set("CDN-Cache-Control", "no-store");
    headers.set("Surrogate-Control", "no-store");
  }
  if (edgeState) headers.set("X-Edge-Cache", edgeState);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function getCacheMeta(p, request) {
  const url = new URL(request.url);
  if (p === "/api/current") return { ttl: 0, tags: ["current", "realtime", "status"] };
  if (p === "/api/timeline") {
    const date = url.searchParams.get("date") || "";
    const window = normalizedHourWindow(url.searchParams.get("window"));
    const ttl = isCurrentTimelineRequest(url) || isLiveWindowRequest(url, window) ? 0 : 60 * 60 * 24 * 30;
    const deviceId = url.searchParams.get("device_id") || "";
    return { ttl, tags: ["timeline", `timeline-${date}`, window ? `timeline-window-${window}` : "", deviceId ? `timeline-device-${deviceId}` : ""].filter(Boolean) };
  }
  if (p === "/api/health-data") {
    const date = url.searchParams.get("date") || "";
    const window = normalizedHourWindow(url.searchParams.get("window"));
    const ttl = isCurrentDateRequest(url) || isLiveWindowRequest(url, window) ? 0 : 60 * 60 * 24 * 30;
    const deviceId = url.searchParams.get("device_id") || "";
    const summary = url.searchParams.get("summary") === "1" || url.searchParams.get("summary") === "true";
    return { ttl, tags: ["health-data", summary ? "health-data-summary" : "health-data-full", `health-data-${date}`, window ? `health-data-window-${window}` : "", deviceId ? `health-device-${deviceId}` : ""].filter(Boolean) };
  }
  if (p === "/api/location") {
    const date = url.searchParams.get("date") || "";
    const window = normalizedHourWindow(url.searchParams.get("window"));
    const ttl = isCurrentTimelineRequest(url) || isLiveWindowRequest(url, window) ? 0 : 60 * 60 * 24 * 30;
    const deviceId = url.searchParams.get("device_id") || "";
    return { ttl, tags: ["location", `location-${date}`, window ? `location-window-${window}` : "", deviceId ? `location-device-${deviceId}` : ""].filter(Boolean) };
  }
  if (p === "/api/config") return { ttl: CACHE_TTL.config, tags: ["config"] };
  if (p === "/api/health") return { ttl: CACHE_TTL.health, tags: ["health"] };
  if (p === "/api/messages/public") return getPublicMessageCacheMeta(url);
  if (p === "/api/daily-summary") return { ttl: 60, tags: ["daily-summary", `daily-summary-${url.searchParams.get("date") || "current"}`] };
  return { ttl: 0, tags: [] };
}

function isCurrentTimelineRequest(url) {
  if (normalizedHourWindow(url.searchParams.get("window"))) return false;
  return isCurrentDateRequest(url);
}

function isCurrentDateRequest(url) {
  const date = url.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return true;
  const tzRaw = url.searchParams.get("tz");
  const tzOffsetMinutes = tzRaw ? parseInt(tzRaw, 10) : 0;
  const safeOffset = Number.isFinite(tzOffsetMinutes) && Math.abs(tzOffsetMinutes) <= 840
    ? tzOffsetMinutes
    : 0;
  const now = new Date(Date.now() - safeOffset * 60_000);
  const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  return date === today;
}

function normalizedHourWindow(value) {
  return value && /^\d{10}$/.test(value) ? value : "";
}

function isLiveWindowRequest(url, window) {
  if (!window) return false;
  const tzRaw = url.searchParams.get("tz");
  const tzOffsetMinutes = tzRaw ? parseInt(tzRaw, 10) : 0;
  const safeOffset = Number.isFinite(tzOffsetMinutes) && Math.abs(tzOffsetMinutes) <= 840
    ? tzOffsetMinutes
    : 0;
  const current = hourWindowForOffset(new Date(), safeOffset);
  const previous = hourWindowForOffset(new Date(Date.now() - 60 * 60 * 1000), safeOffset);
  return window === current || window === previous;
}

function hourWindowForOffset(date, tzOffsetMinutes) {
  const local = new Date(date.getTime() - tzOffsetMinutes * 60_000);
  return `${local.getUTCFullYear()}${String(local.getUTCMonth() + 1).padStart(2, "0")}${String(local.getUTCDate()).padStart(2, "0")}${String(local.getUTCHours()).padStart(2, "0")}`;
}

function isAuthEndpoint(p) {
  return p === "/api/health-data" ||
    p === "/api/location" ||
    p === "/api/messages/public" ||
    p === "/api/messages/private";
}

function isViewerWriteEndpoint(p) {
  return p === "/api/messages/public" || p === "/api/messages/private";
}

function isLocalIp(ip) {
  if (!ip) return false;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" ||
    ip.startsWith("192.168.") || ip.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

function extractViewerToken(request) {
  const auth = request.headers.get("authorization");
  const match = auth?.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) return match[1];
  return new URL(request.url).searchParams.get("viewer_token");
}

function extractBearerToken(request) {
  const auth = request.headers.get("authorization");
  const match = auth?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function parseDeviceTokenList(raw) {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.includes(":") ? entry.split(":")[0] : entry)
    .filter(Boolean);
}

function isDeviceEndpoint(p) {
  return p === "/api/report" ||
    p === "/api/health-data" ||
    p === "/api/location" ||
    p === "/api/messages" ||
    p === "/api/messages/history" ||
    p === "/api/messages/reply" ||
    p === "/api/messages/delete" ||
    p === "/api/messages/remark" ||
    p === "/api/messages/block" ||
    p === "/api/messages/unblock" ||
    p === "/api/messages/blocks" ||
    p === "/api/device";
}

async function isDeviceTokenRequest(request, secret, rawTokens, rawHashes) {
  const token = extractBearerToken(request);
  if (!token) return false;

  const tokens = parseDeviceTokenList(rawTokens);
  if (tokens.includes(token)) return true;

  if (!secret || !rawHashes) return false;
  const expected = new Set(rawHashes.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean));
  if (expected.size === 0) return false;
  const hash = await hmacHex(secret, "device:" + token);
  return expected.has(hash) || expected.has(hash.slice(0, 32));
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
}

function currentHourWindow(date = new Date()) {
  return date.toISOString().slice(0, 13).replace(/[-T:]/g, "");
}

function currentMessageSlot(date = new Date(), slotMinutes = 10) {
  const roundedMinute = Math.floor(date.getUTCMinutes() / slotMinutes) * slotMinutes;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(roundedMinute).padStart(2, "0");
  return `${year}${month}${day}${hour}${minute}`;
}

function getPublicMessageCacheMeta(url) {
  const slot = url.searchParams.get("slot");
  if (slot && /^\d{12}$/.test(slot)) {
    const isCurrent = slot === currentMessageSlot();
    return {
      ttl: isCurrent ? 0 : 60 * 60 * 24 * 30,
      tags: ["public-messages", `public-messages-slot-${slot}`],
    };
  }

  const hourWindow = url.searchParams.get("window") || currentHourWindow();
  if (/^\d{10}$/.test(hourWindow)) {
    const isCurrent = hourWindow === currentHourWindow();
    return {
      ttl: isCurrent ? 0 : 60 * 60 * 24 * 30,
      tags: ["public-messages", `public-messages-${hourWindow}`],
    };
  }

  return { ttl: CACHE_TTL.publicMessages, tags: ["public-messages"] };
}

async function verifyViewerToken(token, secret, clientIp) {
  if (!token || !token.includes(".")) return null;
  const [encoded, signature] = token.split(".", 2);
  if (!encoded || !signature) return null;
  if (await hmacSign(secret, encoded) !== signature) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(encoded));
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!/^fp_[a-f0-9]{32}$/.test(payload.sub)) return null;
    // IP hash is advisory. The stable viewer identity is the fingerprint hash;
    // accepting IP changes prevents refreshes through different CDN/mobile egress
    // from creating false offline/extra-viewer states.
    return { viewerId: await resolveViewerAlias(payload.sub) };
  } catch { return null; }
}

// ── Edge KV ──

function getEdgeKV() {
  try { return new EdgeKV({ namespace: "live-dashboard" }); } catch { return null; }
}

async function kvGetNumber(kv, key) {
  const val = await kvGet(kv, key);
  if (!val) return 0;
  const parts = val.split(":");
  const ts = parseInt(parts[1], 10) || 0;
  if (ts && Date.now() - ts > RATE_WINDOW * 1000) {
    try { await kv.delete(key); } catch {}
    return 0;
  }
  return parseInt(parts[0], 10) || 0;
}

async function kvGetJson(kv, key) {
  try {
    const val = await kv.get(key, { type: "text" });
    if (!val) return null;
    const data = JSON.parse(val);
    if (data.createdAt && Date.now() - data.createdAt > POW_CHALLENGE_TTL * 1000) {
      await kv.delete(key); return null;
    }
    return data;
  } catch { return null; }
}

async function kvGet(kv, key) {
  try { return await kv.get(key, { type: "text" }) || null; } catch { return null; }
}

async function kvGetText(kv, key) {
  try { return await kv.get(key, { type: "text" }) || ""; } catch { return ""; }
}

async function kvPut(kv, key, value, ttl) {
  try { await kv.put(key, `${value}:${Date.now()}`); } catch {}
}

async function kvPutText(kv, key, value) {
  try { await kv.put(key, value); } catch {}
}

async function kvPutJson(kv, key, obj, ttl) {
  try { await kv.put(key, JSON.stringify(obj)); } catch {}
}

async function kvDelete(kv, key) {
  try { await kv.delete(key); } catch {}
}

// ── HMAC (WebCrypto) ──

async function sha256Hex(data) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSign(secret, data) {
  const hex = await hmacHex(secret, data);
  const bytes = hex.match(/.{2}/g).map(b => parseInt(b, 16));
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// ── 响应 ──

function jsonResponse(data, status = 200) {
  return applySecurityHeaders(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders() } }));
}

function noStoreJson(data) {
  return applySecurityHeaders(new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0, s-maxage=0",
      "Pragma": "no-cache",
      "Expires": "0",
      "CDN-Cache-Control": "no-store", "Surrogate-Control": "no-store",
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Origin": "*",
  };
}
