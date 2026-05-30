/**
 * ESA Edge Function — Live Dashboard 边缘计算层
 *
 * 配置存储在 EdgeKV namespace "live-dashboard-config"：
 *   key "origin" → 源站地址 (如 https://live.myallinone.online)
 *   key "secret" → HMAC 密钥 (与源站 HASH_SECRET 一致)
 *
 * 部署前在 EdgeKV 控制台写入这两个 key。
 */

// ── 常量 ──
const CONFIG_NS = "live-dashboard-config";
const CACHE_TTL = { current: 3, timeline: 10, config: 60, publicMessages: 10, health: 5 };
const POW_DIFFICULTY = 4;
const POW_CHALLENGE_TTL = 300;
const RATE_WINDOW = 60;
const RATE_GLOBAL = 300;
const RATE_POW = 30;
const RATE_ISSUE = 12;
const RATE_VIEWER = 60;

// ── 配置加载 ──
async function loadConfig() {
  const kv = new EdgeKV({ namespace: CONFIG_NS });
  const [origin, secret] = await Promise.all([
    kv.get("origin", { type: "text" }),
    kv.get("secret", { type: "text" }),
  ]);
  return { origin: origin || "", secret: secret || "" };
}

// ══════════════════════════════════════════════════════════════
export default {
  async fetch(request) {
    const cfg = await loadConfig();
    const { origin, secret } = cfg;
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
      // 全局 IP 限流
      if (clientIp !== "unknown") {
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

      // 可缓存读取
      if (method === "GET" && getCacheTTL(pathname)) {
        return handleCachedRead(request, origin, pathname, secret);
      }

      // WebSocket — 穿透
      if (pathname === "/api/ws") {
        // ESA 不支持 WebSocket 代理，但可以在边缘验证 token
        // 无效 token 直接拒绝，有效才穿透
        if (secret) {
          const token = extractViewerToken(request);
          if (!token) {
            return jsonResponse({ error: "需要 viewer token" }, 403);
          }
          const verified = await verifyViewerToken(token, secret, clientIp);
          if (!verified) {
            return jsonResponse({ error: "token 无效" }, 403);
          }
          // 全局限流
          const kv = getEdgeKV();
          if (kv) {
            const rate = await kvGetNumber(kv, `vr:${verified.viewerId}`);
            if (rate >= RATE_VIEWER) return jsonResponse({ error: "限流" }, 429);
            kvPut(kv, `vr:${verified.viewerId}`, String((rate || 0) + 1), RATE_WINDOW);
          }
        }
        return passthrough(request, origin, clientIp);
      }

      // 需要 token 的端点 — 边缘验证后穿透
      if (method === "GET" && isAuthEndpoint(pathname)) {
        return handleAuthenticatedRequest(request, origin, clientIp, secret);
      }

      // 其他 — 穿透
      return passthroughSigned(request, origin, clientIp, secret);
    } catch {
      return passthroughSigned(request, origin, clientIp, secret);
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

  // 生成挑战
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const challenge = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");

  // 存储到 KV
  await kvPutJson(kv, `pc:${challenge}`, { ip: clientIp, ipUpdated: false, createdAt: Date.now() }, POW_CHALLENGE_TTL);

  return noStoreJson({ challenge, difficulty: POW_DIFFICULTY, expiresIn: POW_CHALLENGE_TTL });
}

// ══════════════════════════════════════════════════════════════
// Token 签发
// ══════════════════════════════════════════════════════════════

async function handleTokenIssue(request, clientIp, secret) {
  if (!secret) return null; // 回源

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "无效 JSON" }, 400); }

  const { fingerprint, pow_challenge, pow_nonce } = body;
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
    if (!pow_challenge || !pow_nonce) return jsonResponse({ error: "需要 PoW", code: "POW_REQUIRED" }, 403);

    const challengeData = kv ? await kvGetJson(kv, `pc:${pow_challenge}`) : null;
    if (!challengeData) return jsonResponse({ error: "PoW 无效或过期", code: "POW_INVALID" }, 403);

    // IP 绑定（允许一次变更）
    if (challengeData.ip !== clientIp) {
      if (challengeData.ipUpdated) { if (kv) await kvDelete(kv, `pc:${pow_challenge}`); return jsonResponse({ error: "PoW IP 不匹配" }, 403); }
      challengeData.ipUpdated = true;
    }

    // 验证 SHA-256
    const input = pow_challenge + pow_nonce;
    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
    if (!hashHex.startsWith("0".repeat(POW_DIFFICULTY))) return jsonResponse({ error: "PoW 解无效" }, 403);

    if (kv) await kvDelete(kv, `pc:${pow_challenge}`);
  }

  // 签发 token
  const fp = fingerprint.replace(/[^a-zA-Z0-9:_.,| -]/g, "").trim().slice(0, 512);
  if (fp.length < 32 || new Set(fp).size < 6) return jsonResponse({ error: "fingerprint 太弱" }, 400);

  const viewerId = `fp_${await hmacHex(secret, fp)}`.slice(0, 35);
  const ipHash = (ipKnown && clientIp !== "unknown") ? (await hmacHex(secret, "ip:" + clientIp)).slice(0, 16) : "";
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ sub: viewerId, ip: ipHash, iat: nowSec, exp: nowSec + 3600 });
  const encoded = btoa(payload).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const signature = await hmacSign(secret, encoded);

  return noStoreJson({ token: `${encoded}.${signature}`, viewer_id: viewerId, expires_in: 3600 });
}

// ══════════════════════════════════════════════════════════════
// 缓存读取
// ══════════════════════════════════════════════════════════════

async function handleCachedRead(request, origin, pathname, secret) {
  const ttl = getCacheTTL(pathname);
  const cacheKey = `http://edge-cache${pathname}${new URL(request.url).search}`;

  try {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  } catch {}

  const originResp = await fetch(`${origin}${pathname}${new URL(request.url).search}`, {
    headers: {
      "X-Forwarded-For": request.headers.get("x-real-ip") || "",
      "X-Real-IP": request.headers.get("x-real-ip") || "",
      "X-Edge-Internal": secret ? await hmacHex(secret, "edge-internal") : "",
    },
  });
  if (!originResp.ok) return originResp;

  const respHeaders = new Headers(originResp.headers);
  respHeaders.set("Cache-Control", `public, max-age=${ttl}, s-maxage=${ttl}`);
  respHeaders.set("X-Edge-Cache", "MISS");
  const response = new Response(originResp.body, { status: originResp.status, headers: respHeaders });

  try { await cache.put(cacheKey, response.clone()); } catch {}
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

      const ttl = getCacheTTL(getPath(request));
      if (ttl && resp.ok) {
        const h = new Headers(resp.headers);
        h.set("Cache-Control", `public, max-age=${ttl}, s-maxage=${ttl}`);
        return new Response(resp.body, { status: resp.status, headers: h });
      }
      return resp;
    }
    return jsonResponse({ error: "token 无效" }, 403);
  }

  const path = getPath(request);
  if (path === "/api/health-data" || path === "/api/location") {
    return jsonResponse({ error: "需要 viewer token" }, 403);
  }
  return passthroughSigned(request, origin, clientIp, secret);
}

// ══════════════════════════════════════════════════════════════
// WebSocket
// ══════════════════════════════════════════════════════════════

async function handleWebSocket(request, origin, clientIp, secret) {
  const headers = new Headers(request.headers);
  headers.set("X-Real-IP", clientIp);
  if (secret) {
    headers.set("X-Edge-Internal", await hmacHex(secret, "edge-internal"));
    const token = extractViewerToken(request);
    if (token) {
      const verified = await verifyViewerToken(token, secret, clientIp);
      if (verified) {
        headers.set("X-Edge-Verified", "true");
        headers.set("X-Edge-Viewer-Id", verified.viewerId);
        headers.set("X-Edge-Signature", await hmacHex(secret, "edge:" + verified.viewerId));
      }
    }
  }
  return fetch(`${origin}/api/ws${new URL(request.url).search}`, { method: request.method, headers });
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
  });
}

function passthroughSigned(request, origin, clientIp, secret) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  if (clientIp) headers.set("X-Real-IP", clientIp);
  // Note: internal signature is set async by callers where needed
  return fetch(`${origin}${url.pathname}${url.search}`, {
    method: request.method, headers,
    body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
  });
}

function getCacheTTL(p) {
  if (p === "/api/current") return CACHE_TTL.current;
  if (p === "/api/timeline") return CACHE_TTL.timeline;
  if (p === "/api/config") return CACHE_TTL.config;
  if (p === "/api/health") return CACHE_TTL.health;
  if (p === "/api/daily-summary") return 60;
  return 0;
}

function isAuthEndpoint(p) {
  return p === "/api/health-data" || p === "/api/location" || p === "/api/messages" || p === "/api/messages/history" || p === "/api/messages/public";
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

async function verifyViewerToken(token, secret, clientIp) {
  if (!token || !token.includes(".")) return null;
  const [encoded, signature] = token.split(".", 2);
  if (!encoded || !signature) return null;
  if (await hmacSign(secret, encoded) !== signature) return null;
  try {
    const payload = JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!/^fp_[a-f0-9]{32}$/.test(payload.sub)) return null;
    if (payload.ip && clientIp && clientIp !== "unknown") {
      const currentIpHash = (await hmacHex(secret, "ip:" + clientIp)).slice(0, 16);
      if (payload.ip !== currentIpHash) return null;
    }
    return { viewerId: payload.sub };
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
  if (ts && Date.now() - ts > RATE_WINDOW * 1000) return 0;
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

async function kvPut(kv, key, value, ttl) {
  try { await kv.put(key, `${value}:${Date.now()}`); } catch {}
}

async function kvPutJson(kv, key, obj, ttl) {
  try { await kv.put(key, JSON.stringify(obj)); } catch {}
}

async function kvDelete(kv, key) {
  try { await kv.delete(key); } catch {}
}

// ── HMAC (WebCrypto) ──

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
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

function noStoreJson(data) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0, s-maxage=0",
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
