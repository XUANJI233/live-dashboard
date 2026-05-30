/**
 * ESA Edge Function — Live Dashboard 边缘计算层
 *
 * 架构：浏览器 → ESA 边缘 → 源站（仅必要时回源）
 *
 * 能力：
 * 1. PoW 挑战/验证完全在边缘完成（Edge KV 存储，彻底解决 CDN 缓存问题）
 * 2. 读取端点使用 Cache API 缓存，大幅减少回源
 * 3. Token 验证在边缘完成（WebCrypto HMAC），无效请求不回源
 * 4. 写入请求限流后穿透到源站
 *
 * 环境变量（在 ESA 控制台配置）：
 * - ORIGIN_URL: 源站地址，如 http://172.20.0.80:3000
 * - HASH_SECRET: HMAC 密钥（与源站一致）
 * - EDGE_POW_DIFFICULTY: PoW 难度（默认 4）
 */

// ── 配置 ──
const CACHE_TTL = {
  current: 3,        // /api/current 缓存 3 秒
  timeline: 10,      // /api/timeline 缓存 10 秒
  config: 60,        // /api/config 缓存 60 秒
  publicMessages: 10, // /api/messages/public 缓存 10 秒
  health: 5,         // /api/health 缓存 5 秒
};

const POW_DIFFICULTY = 4;
const POW_CHALLENGE_TTL = 300; // 5 分钟
const RATE_LIMIT_WINDOW = 60;  // 1 分钟
const RATE_LIMIT_MAX = 300;    // 每窗口最大请求数（边缘放宽，源站 120）

export default {
  async fetch(request, env) {
    const origin = env.ORIGIN_URL || "http://localhost:3000";
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;
    const clientIp = request.headers.get("x-real-ip") ||
                     request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
                     "unknown";

    // ── CORS 预检 ──
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(pathname),
      });
    }

    try {
      // ── 路由分发 ──

      // Global per-IP rate limit (300/min, relaxed vs origin's 120/min)
      const kv = getEdgeKV(env);
      if (kv && clientIp !== "unknown") {
        const globalRateKey = `global_rate:${clientIp}`;
        const globalCount = await kvGetNumber(kv, globalRateKey);
        if (globalCount >= RATE_LIMIT_MAX) {
          return jsonResponse({ error: "Rate limit exceeded", retryAfter: 60 }, 429);
        }
        // Increment (fire-and-forget to avoid blocking)
        kvPut(kv, globalRateKey, String((globalCount || 0) + 1), RATE_LIMIT_WINDOW);
      }
      // 1. PoW 挑战：完全在边缘处理
      if (pathname === "/api/pow/challenge" && method === "GET") {
        return handlePowChallenge(clientIp, env);
      }

      // 2. Token 签发：边缘验证 PoW + 签发 token
      if (pathname === "/api/token/issue" && method === "POST") {
        return handleTokenIssue(request, clientIp, env);
      }

      // 3. 可缓存的读取端点
      if (method === "GET" && isCacheableEndpoint(pathname)) {
        return handleCachedRead(request, origin, pathname, env);
      }

      // 4. WebSocket：直接穿透到源站
      if (pathname === "/api/ws") {
        return handleWebSocket(request, origin, clientIp, env);
      }

      // 5. 需要 token 验证的端点：边缘验证后穿透
      if (isAuthenticatedEndpoint(pathname, method)) {
        return handleAuthenticatedRequest(request, origin, clientIp, env);
      }

      // 6. 设备上报：直接穿透（已有设备 token 验证）
      if (pathname === "/api/report" && method === "POST") {
        return passthrough(request, origin, clientIp);
      }

      // 7. 其他请求：穿透到源站
      return passthrough(request, origin, clientIp);
    } catch (err) {
      // 边缘函数出错时回源
      console.error("[edge] Error:", err);
      return passthrough(request, origin, clientIp);
    }
  },
};

// ══════════════════════════════════════════════════════════════
// PoW 挑战 — 完全在边缘处理
// ══════════════════════════════════════════════════════════════

async function handlePowChallenge(clientIp, env) {
  // 本地 IP 跳过 PoW
  if (!clientIp || clientIp === "unknown" || isLocalIp(clientIp)) {
    return jsonResponse({ skip: true, message: "Local IP — PoW not required" });
  }

  const kv = getEdgeKV(env);
  if (!kv) {
    // Edge KV 不可用时回源
    return null; // 让调用方回源
  }

  // 检查该 IP 的挑战频率限制
  const rateKey = `pow_rate:${clientIp}`;
  const rateCount = await kvGetNumber(kv, rateKey);
  if (rateCount >= 30) {
    return jsonResponse({ error: "Too many PoW requests", retryAfter: 60 }, 429);
  }
  await kvPut(kv, rateKey, String((rateCount || 0) + 1), RATE_LIMIT_WINDOW);

  // 生成挑战
  const challengeBytes = new Uint8Array(32);
  crypto.getRandomValues(challengeBytes);
  const challenge = Array.from(challengeBytes).map(b => b.toString(16).padStart(2, "0")).join("");

  // 存储到 Edge KV（IP 绑定）
  const challengeData = JSON.stringify({ ip: clientIp, ipUpdated: false, createdAt: Date.now() });
  await kvPut(kv, `pow:${challenge}`, challengeData, POW_CHALLENGE_TTL);

  return noStoreJsonResponse({
    challenge,
    difficulty: POW_DIFFICULTY,
    expiresIn: POW_CHALLENGE_TTL,
  });
}

// ══════════════════════════════════════════════════════════════
// Token 签发 — 边缘验证 PoW + 签发
// ══════════════════════════════════════════════════════════════

async function handleTokenIssue(request, clientIp, env) {
  const kv = getEdgeKV(env);
  const secret = env.HASH_SECRET;
  if (!kv || !secret) {
    return null; // 回源
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const { fingerprint, pow_challenge, pow_nonce } = body;
  if (!fingerprint || typeof fingerprint !== "string") {
    return jsonResponse({ error: "fingerprint required" }, 400);
  }

  // IP 频率限制
  const issueRateKey = `issue_rate:${clientIp}`;
  const issueCount = await kvGetNumber(kv, issueRateKey);
  if (issueCount >= 12) {
    return jsonResponse({ error: "rate limited" }, 429);
  }
  await kvPut(kv, issueRateKey, String((issueCount || 0) + 1), RATE_LIMIT_WINDOW);

  // PoW 验证（非本地 IP 必须提供）
  const ipKnown = clientIp && clientIp !== "unknown";
  if (ipKnown && !isLocalIp(clientIp)) {
    if (!pow_challenge || !pow_nonce) {
      return jsonResponse({ error: "PoW challenge and nonce required", code: "POW_REQUIRED" }, 403);
    }

    // 从 Edge KV 获取挑战
    const challengeData = await kvGetJson(kv, `pow:${pow_challenge}`);
    if (!challengeData) {
      return jsonResponse({ error: "Invalid or expired PoW challenge", code: "POW_INVALID" }, 403);
    }

    // 验证 IP 绑定（允许一次变更）
    if (challengeData.ip !== clientIp) {
      if (challengeData.ipUpdated) {
        await kvDelete(kv, `pow:${pow_challenge}`);
        return jsonResponse({ error: "PoW IP mismatch", code: "POW_INVALID" }, 403);
      }
      challengeData.ipUpdated = true;
    }

    // 验证 PoW 解
    const input = pow_challenge + pow_nonce;
    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
    const requiredZeros = "0".repeat(POW_DIFFICULTY);

    if (!hashHex.startsWith(requiredZeros)) {
      return jsonResponse({ error: "Invalid PoW solution", code: "POW_INVALID" }, 403);
    }

    // 删除已使用的挑战
    await kvDelete(kv, `pow:${pow_challenge}`);
  }

  // 签发 viewer token（与源站逻辑一致）
  const fingerprintClean = fingerprint.replace(/[^a-zA-Z0-9:_.,| -]/g, "").trim().slice(0, 512);
  if (fingerprintClean.length < 32 || new Set(fingerprintClean).size < 6) {
    return jsonResponse({ error: "fingerprint too weak" }, 400);
  }

  const viewerId = `fp_${await hmacHex(secret, fingerprintClean)}`.slice(0, 35);
  const ipHash = (ipKnown && clientIp !== "unknown")
    ? await hmacHex(secret, "ip:" + clientIp)
    : "";
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ sub: viewerId, ip: ipHash.slice(0, 16), iat: nowSec, exp: nowSec + 3600 });
  const encoded = btoa(payload).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const signature = await hmacSign(secret, encoded);
  const token = `${encoded}.${signature}`;

  return noStoreJsonResponse({
    token,
    viewer_id: viewerId,
    expires_in: 3600,
  });
}

// ══════════════════════════════════════════════════════════════
// 可缓存读取 — Cache API
// ══════════════════════════════════════════════════════════════

async function handleCachedRead(request, origin, pathname, env) {
  const ttl = getCacheTTL(pathname);
  if (!ttl) {
    return passthrough(request, origin);
  }

  // 构建缓存 key（使用 HTTP URL，ESA Cache API 不支持 HTTPS key）
  const cacheKey = `http://edge-cache${pathname}${new URL(request.url).search}`;

  try {
    // ESA Cache API uses global `cache` object
    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }
  } catch {
    // Cache API 不可用，直接回源
  }

  // 回源
  const originResponse = await fetch(`${origin}${pathname}${new URL(request.url).search}`, {
    headers: {
      "X-Forwarded-For": request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for") || "",
      "X-Real-IP": request.headers.get("x-real-ip") || "",
      "Accept": request.headers.get("accept") || "*/*",
    },
  });

  if (!originResponse.ok) {
    return originResponse;
  }

  // 构建可缓存的响应
  const responseHeaders = new Headers(originResponse.headers);
  responseHeaders.set("Cache-Control", `public, max-age=${ttl}, s-maxage=${ttl}`);
  responseHeaders.set("X-Edge-Cache", "MISS");

  const response = new Response(originResponse.body, {
    status: originResponse.status,
    headers: responseHeaders,
  });

  // 写入缓存
  try {
    await cache.put(cacheKey, response.clone());
  } catch {
    // 忽略缓存写入错误
  }

  return response;
}

// ══════════════════════════════════════════════════════════════
// Token 验证 — WebCrypto HMAC 边缘验证
// ══════════════════════════════════════════════════════════════

async function handleAuthenticatedRequest(request, origin, clientIp, env) {
  const secret = env.HASH_SECRET;
  if (!secret) {
    return passthrough(request, origin, clientIp);
  }

  // 提取 token
  const token = extractViewerToken(request);
  if (token) {
    const verified = await verifyViewerTokenEdge(token, secret, clientIp);
    if (verified) {
      // Per-viewer rate limit for authenticated endpoints (60/min, relaxed)
      const kv = getEdgeKV(env);
      if (kv) {
        const viewerRateKey = `viewer_rate:${verified.viewerId}`;
        const viewerCount = await kvGetNumber(kv, viewerRateKey);
        if (viewerCount >= 60) {
          return jsonResponse({ error: "Rate limit exceeded", retryAfter: 60 }, 429);
        }
        kvPut(kv, viewerRateKey, String((viewerCount || 0) + 1), RATE_LIMIT_WINDOW);
      }
      // Token 有效：添加验证头，穿透到源站
      const headers = new Headers(request.headers);
      const edgeSig = await hmacHex(secret, "edge:" + verified.viewerId);
      headers.set("X-Edge-Verified", "true");
      headers.set("X-Edge-Viewer-Id", verified.viewerId);
      headers.set("X-Edge-Signature", edgeSig);
      headers.set("X-Real-IP", clientIp);

      const newRequest = new Request(request.url, {
        method: request.method,
        headers,
        body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
      });

      const response = await fetch(`${origin}${new URL(request.url).pathname}${new URL(request.url).search}`, newRequest);

      // 给响应加缓存头（可缓存端点）
      const ttl = getCacheTTL(new URL(request.url).pathname);
      if (ttl && response.ok) {
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set("Cache-Control", `public, max-age=${ttl}, s-maxage=${ttl}`);
        return new Response(response.body, { status: response.status, headers: responseHeaders });
      }
      return response;
    }
    // Token 无效
    return jsonResponse({ error: "Invalid viewer token" }, 403);
  }

  // 没有 token — 检查是否是可缓存的公开端点
  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/health-data" || pathname === "/api/location") {
    return jsonResponse({ error: "Viewer token required" }, 403);
  }

  return passthrough(request, origin, clientIp);
}

async function verifyViewerTokenEdge(token, secret, clientIp) {
  if (!token || !token.includes(".")) return null;
  const parts = token.split(".", 2);
  const [encoded, signature] = parts;
  if (!encoded || !signature) return null;

  // 验证签名
  const expectedSig = await hmacSign(secret, encoded);
  if (expectedSig !== signature) return null;

  try {
    const payload = JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!/^fp_[a-f0-9]{32}$/.test(payload.sub)) return null;

    // IP 绑定检查
    if (payload.ip && clientIp && clientIp !== "unknown") {
      const currentIpHash = (await hmacHex(secret, "ip:" + clientIp)).slice(0, 16);
      if (payload.ip !== currentIpHash) return null;
    }

    return { viewerId: payload.sub };
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// WebSocket — 穿透到源站
// ══════════════════════════════════════════════════════════════

async function handleWebSocket(request, origin, clientIp, env) {
  // WebSocket 验证 token 后穿透
  const headers = new Headers(request.headers);
  headers.set("X-Real-IP", clientIp);

  const secret = env.HASH_SECRET;
  if (secret) {
    const token = extractViewerToken(request);
    if (token) {
      const verified = await verifyViewerTokenEdge(token, secret, clientIp);
      if (verified) {
        const edgeSig = await hmacHex(secret, "edge:" + verified.viewerId);
        headers.set("X-Edge-Verified", "true");
        headers.set("X-Edge-Viewer-Id", verified.viewerId);
        headers.set("X-Edge-Signature", edgeSig);
      }
    }
  }

  return fetch(`${origin}/api/ws${new URL(request.url).search}`, {
    method: request.method,
    headers,
  });
}

// ══════════════════════════════════════════════════════════════
// 工具函数
// ══════════════════════════════════════════════════════════════

function passthrough(request, origin, clientIp) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  if (clientIp) headers.set("X-Real-IP", clientIp);

  return fetch(`${origin}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
  });
}

function isCacheableEndpoint(pathname) {
  return pathname === "/api/current" ||
         pathname === "/api/timeline" ||
         pathname === "/api/config" ||
         pathname === "/api/health" ||
         pathname === "/api/messages/public" ||
         pathname === "/api/daily-summary";
}

function getCacheTTL(pathname) {
  if (pathname === "/api/current") return CACHE_TTL.current;
  if (pathname === "/api/timeline") return CACHE_TTL.timeline;
  if (pathname === "/api/config") return CACHE_TTL.config;
  if (pathname === "/api/health") return CACHE_TTL.health;
  if (pathname === "/api/messages/public") return CACHE_TTL.publicMessages;
  return 0;
}

function isAuthenticatedEndpoint(pathname, method) {
  if (method !== "GET") return false;
  return pathname === "/api/health-data" ||
         pathname === "/api/location" ||
         pathname === "/api/messages" ||
         pathname === "/api/messages/history";
}

function extractViewerToken(request) {
  const auth = request.headers.get("authorization");
  const match = auth?.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) return match[1];
  const url = new URL(request.url);
  return url.searchParams.get("viewer_token");
}

function isLocalIp(ip) {
  if (!ip) return false;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" ||
    ip.startsWith("192.168.") || ip.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

// ── Edge KV 辅助 ──

function getEdgeKV(env) {
  try {
    // ESA Edge KV 需要在控制台创建 namespace
    // 这里假设 env.EDGE_KV_NAMESPACE 已配置
    if (typeof EdgeKV !== "undefined") {
      return new EdgeKV({ namespace: env.EDGE_KV_NAMESPACE || "live-dashboard" });
    }
  } catch {}
  return null;
}

async function kvGetNumber(kv, key) {
  const val = await kvGet(kv, key);
  if (!val) return 0;
  // Check TTL: format is "value:timestamp"
  const parts = val.split(":");
  const num = parseInt(parts[0], 10);
  const ts = parseInt(parts[1], 10) || 0;
  if (ts && Date.now() - ts > RATE_LIMIT_WINDOW * 1000) return 0; // expired
  return num || 0;
}

async function kvGetJson(kv, key) {
  try {
    const val = await kv.get(key, { type: "text" });
    if (!val) return null;
    const data = JSON.parse(val);
    // Check TTL from createdAt field
    if (data.createdAt && Date.now() - data.createdAt > POW_CHALLENGE_TTL * 1000) {
      await kvDelete(kv, key); // clean up expired
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

async function kvGet(kv, key) {
  try {
    return await kv.get(key, { type: "text" }) || null;
  } catch {
    return null;
  }
}

async function kvPut(kv, key, value, ttlSeconds) {
  try {
    // Store with timestamp for TTL checking
    await kv.put(key, `${value}:${Date.now()}`);
  } catch {}
}

async function kvDelete(kv, key) {
  try {
    await kv.delete(key);
  } catch {}
}

// ── HMAC 辅助（WebCrypto） ──

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSign(secret, data) {
  const hex = await hmacHex(secret, data);
  const bytes = hex.match(/.{2}/g).map(b => parseInt(b, 16));
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// ── 响应辅助 ──

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders("/api"),
    },
  });
}

function noStoreJsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0, s-maxage=0",
      "Pragma": "no-cache",
      "Expires": "0",
      "CDN-Cache-Control": "no-store",
      "Surrogate-Control": "no-store",
      ...corsHeaders("/api"),
    },
  });
}

function corsHeaders(pathname) {
  return {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Origin": "*",
  };
}
