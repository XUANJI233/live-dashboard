/**
 * ESA Edge Function — Live Dashboard 边缘计算层
 *
 * 配置存储在 EdgeKV namespace "live-dashboard-config"（单个 key "config"）：
 *   JSON: { origin, secret, device_tokens, device_token_hashes, cors_allowed_origins }
 *
 * 部署前至少在 EdgeKV 控制台写入 config 键。
 */

// ── 常量 ──
const CONFIG_NS = "live-dashboard-config";
const CONFIG_KEY = "config"; // 合并为单个 key，避免超过 ESA 子请求数限制（4 次 fetch）
const CACHE_TTL = { config: 60, publicMessages: 10, health: 5 };
const POW_DIFFICULTY = 4;
const POW_DIFFICULTY_BITS = 17;
const POW_ALGORITHM = "hashcash-v2";
const POW_CHALLENGE_TTL = 300;
const MAX_DEVICE_TOKENS = 100;
const RATE_WINDOW = 60;
const RATE_GLOBAL = 300;
const RATE_POW = 30;
const RATE_ISSUE = 12;
const RATE_VIEWER = 60;
const memoryRate = new Map();
const CONFIG_CACHE_MS = 30_000;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const hmacKeyCache = new Map();
let configCache = { value: null, expiresAt: 0 };

// 超时包装（ESA 推荐模式）
function withTimeout(promise, ms, fallback) {
  let timer = null;
  let settled = false;
  return new Promise((resolve) => {
    timer = setTimeout(() => {
      settled = true;
      resolve(fallback);
    }, ms);
    Promise.resolve(promise)
      .then((value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(fallback);
      });
  });
}

function getClientIpFromHeaders(headers) {
  const forwarded = headers.get("x-forwarded-for") || "";
  const forwardedIp = forwarded ? forwarded.split(",")[0].trim() : "";
  return headers.get("ali-real-client-ip") ||
    headers.get("x-real-ip") ||
    headers.get("cf-connecting-ip") ||
    forwardedIp ||
    "unknown";
}

// ── 配置加载（单次 EdgeKV 读取）──
async function loadConfig() {
  const now = Date.now();
  if (configCache.value && configCache.expiresAt > now) return configCache.value;

  let jsonStr = "";
  let result = null;
  try {
    const kv = new EdgeKV({ namespace: CONFIG_NS });
    jsonStr = await withTimeout(kv.get(CONFIG_KEY, { type: "text" }), 2000, "");
  } catch {
    result = { origin: "", secret: "", deviceTokens: "", deviceTokenHashes: "", corsAllowedOrigins: "", configError: `EdgeKV read failed: ${CONFIG_NS}/${CONFIG_KEY}` };
    configCache = { value: result, expiresAt: now + 5_000 };
    return result;
  }
  if (jsonStr === undefined) result = { origin: "", secret: "", deviceTokens: "", deviceTokenHashes: "", corsAllowedOrigins: "", configError: `missing ${CONFIG_NS}/${CONFIG_KEY}` };
  if (!result && !jsonStr) result = { origin: "", secret: "", deviceTokens: "", deviceTokenHashes: "", corsAllowedOrigins: "", configError: `empty ${CONFIG_NS}/${CONFIG_KEY}` };
  if (result) {
    configCache = { value: result, expiresAt: now + 5_000 };
    return result;
  }
  try {
    const cfg = JSON.parse(jsonStr);
    result = {
      origin: cfg.origin || "",
      secret: cfg.secret || "",
      deviceTokens: cfg.device_tokens || "",
      deviceTokenHashes: cfg.device_token_hashes || "",
      corsAllowedOrigins: cfg.cors_allowed_origins || cfg.corsAllowedOrigins || "",
      configError: cfg.origin ? "" : `origin empty in ${CONFIG_NS}/${CONFIG_KEY}`,
    };
    configCache = { value: result, expiresAt: now + CONFIG_CACHE_MS };
    return result;
  } catch {
    result = { origin: "", secret: "", deviceTokens: "", deviceTokenHashes: "", corsAllowedOrigins: "", configError: `invalid JSON in ${CONFIG_NS}/${CONFIG_KEY}` };
    configCache = { value: result, expiresAt: now + 5_000 };
    return result;
  }
}

// ══════════════════════════════════════════════════════════════
export default {
  async fetch(request) {
    const cfg = await loadConfig();
    const { origin, secret, deviceTokens, deviceTokenHashes, corsAllowedOrigins } = cfg;
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;
    const cors = corsHeaders(request, pathname, method, corsAllowedOrigins);
    if (!origin) {
      return applySecurityHeaders(new Response(`边缘配置缺失：${cfg.configError || "origin empty"}`, {
        status: 500,
        headers: cors,
      }), cors);
    }

    const clientIp = getClientIpFromHeaders(request.headers);

    // CORS 预检
    if (method === "OPTIONS") {
      ignoreRequestBody(request);
      return applySecurityHeaders(new Response(null, { status: 204, headers: cors }), cors);
    }

    // 内部请求旁路（HMAC 签名验证，防伪造）
    const internalSig = request.headers.get("x-edge-internal");
    if (internalSig && secret) {
      if (internalSig === await hmacHex(secret, "edge-internal")) {
        return passthrough(request, origin, clientIp, cors);
      }
    }

    try {
      // 可信设备请求直接签名回源。放在边缘限流和访客鉴权前，避免管理员设备被误限或误判为 viewer token。
      const isTrustedDevice = await isDeviceTokenRequest(request, secret, deviceTokens, deviceTokenHashes);
        if (isTrustedDevice && isDeviceEndpoint(pathname, method)) {
        return passthroughSigned(request, origin, clientIp, secret, cors);
      }

      // 全局 IP 限流
      if (clientIp !== "unknown" && !isTrustedDevice && !hasEndpointRateLimit(pathname, method)) {
        const allowed = usesEdgeReadBudget(pathname, method, request)
          ? allowMemoryRate("r_g", clientIp, RATE_GLOBAL)
          : await allowRate(getEdgeKV(), "g", clientIp, RATE_GLOBAL);
        if (!allowed) {
          return jsonResponse({ error: "限流", retryAfter: 60 }, 429, cors);
        }
      }

      // PoW 挑战 — 完全边缘处理
      if (pathname === "/api/pow/challenge" && method === "GET") {
        const powResp = await handlePowChallenge(request, clientIp, secret, cors);
        if (powResp) return powResp;
        return passthroughSigned(request, origin, clientIp, secret, cors);
      }

      // Token 签发 — 边缘验证 PoW + 签发
      if (pathname === "/api/token/issue" && method === "POST") {
        const tokenResp = await handleTokenIssue(request, clientIp, secret, cors);
        if (tokenResp) return tokenResp;
        return passthroughSigned(request, origin, clientIp, secret, cors);
      }

      // 由边缘统一管理缓存头/标签的读取。ttl=0 也会经过这里，以便强制 no-store 并补齐 Cache-Tag。
      const cacheMeta = getCacheMeta(pathname, request);
      if (method === "GET" && (cacheMeta.ttl > 0 || (cacheMeta.tags && cacheMeta.tags.length))) {
        return handleCachedRead(request, origin, pathname, secret, cacheMeta, cors);
      }

      // WebSocket — 穿透前验证 token，拒绝无效连接节省源站资源
      if (pathname === "/api/ws") {
        const auth = request.headers.get("authorization") || "";
        const role = url.searchParams.get("role") || "";
        // Device token: check whitelist at edge
        if (role === "device") {
          if (await isDeviceTokenRequest(request, secret, deviceTokens, deviceTokenHashes)) {
            return passthrough(request, origin, clientIp, cors);
          }
          return jsonResponse({ error: "无效的设备令牌" }, 403, cors);
        }
        // Viewer token: verify at edge
        if (role === "viewer") {
          const token = auth.startsWith("Bearer ") ? auth.slice(7) : (auth || url.searchParams.get("viewer_token") || "");
          const verified = token && secret ? await verifyViewerToken(token, secret, clientIp) : null;
          if (verified) {
            return passthrough(request, origin, clientIp, cors); // origin validates again before upgrade
          }
          ignoreRequestBody(request);
          return jsonResponse({ error: "需要访客令牌" }, 403, cors);
        }
        ignoreRequestBody(request);
        return jsonResponse({ error: "需要 role 参数 (device/viewer)" }, 400, cors);
      }

      // 访客写入端点在边缘先验 token 和限流，挡掉无效脚本请求再回源。
      if (method === "POST" && isViewerWriteEndpoint(pathname)) {
        return handleAuthenticatedRequest(request, origin, clientIp, secret, cors);
      }

      // 需要 token 的端点 — 边缘验证后穿透
      if (method === "GET" && isAuthEndpoint(pathname)) {
        return handleAuthenticatedRequest(request, origin, clientIp, secret, cors);
      }

      // 其他 — 穿透
      return passthroughSigned(request, origin, clientIp, secret, cors);
    } catch {
      ignoreRequestBody(request);
      if (isProtectedEdgeEndpoint(pathname, method)) {
        return jsonResponse({ error: "边缘验证暂时不可用" }, 503, cors);
      }
      return passthroughSigned(request, origin, clientIp, secret, cors);
    }
  },
};

// ══════════════════════════════════════════════════════════════
// PoW 挑战
// ══════════════════════════════════════════════════════════════

async function handlePowChallenge(request, clientIp, secret, cors) {
  const json = (data, status) => jsonResponse(data, status, cors);
  if (!clientIp || clientIp === "unknown" || isLocalIp(clientIp)) {
    return json({ skip: true, message: "本地 IP 无需 PoW" });
  }
  if (!secret) return null; // caller will fallback to passthrough
  const kv = getEdgeKV();

  // 限流 30/min
  if (kv && !(await allowRate(kv, "pr", clientIp, RATE_POW))) {
    return json({ error: "PoW 请求过多", retryAfter: 60 }, 429);
  }

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const random = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  const fpHash = sanitizePowFingerprintHash(new URL(request.url).searchParams.get("fp_hash") || "");
  if (!fpHash) return json({ error: "需要 fingerprint hash", code: "POW_FINGERPRINT_REQUIRED" }, 400);
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    v: 2,
    alg: POW_ALGORITHM,
    r: random,
    fp: fpHash,
    iat: nowSec,
    exp: nowSec + POW_CHALLENGE_TTL,
    bits: POW_DIFFICULTY_BITS,
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const challenge = `${encoded}.${await hmacSign(secret, encoded)}`;

  return noStoreJson({
    challenge,
    difficulty: POW_DIFFICULTY,
    difficultyBits: POW_DIFFICULTY_BITS,
    algorithm: POW_ALGORITHM,
    expiresIn: POW_CHALLENGE_TTL,
  }, cors);
}

// ══════════════════════════════════════════════════════════════
// Token 签发
// ══════════════════════════════════════════════════════════════

async function handleTokenIssue(request, clientIp, secret, cors) {
  const json = (data, status) => jsonResponse(data, status, cors);
  if (!secret) return null; // 回源

  let body;
  try { body = await request.json(); } catch { return json({ error: "无效 JSON" }, 400); }

  const { fingerprint, pow_challenge, pow_result } = body;
  if (!fingerprint || typeof fingerprint !== "string") return json({ error: "需要 fingerprint" }, 400);

  // 限流 12/min
  const kv = getEdgeKV();
  if (kv && !(await allowRate(kv, "ir", clientIp, RATE_ISSUE))) {
    return json({ error: "限流" }, 429);
  }

  // PoW 验证
  const ipKnown = clientIp && clientIp !== "unknown";
  if (ipKnown && !isLocalIp(clientIp)) {
    if (!pow_challenge || !pow_result) return json({ error: "需要 PoW", code: "POW_REQUIRED" }, 403);

    const challengeData = await verifyPowChallenge(pow_challenge, secret);
    if (!challengeData) return json({ error: "PoW 无效或过期", code: "POW_INVALID" }, 403);

    // Parse pow_result JSON
    let powResult;
    try { powResult = JSON.parse(pow_result); } catch { return json({ error: "PoW 格式无效" }, 403); }

    if (!powResult || typeof powResult.nonce !== "string" || !powResult.nonce) {
      return json({ error: "需要完整 PoW 结果", code: "POW_INCOMPLETE" }, 403);
    }

    if (challengeData.fp) {
      const fingerprintHash = await sha256Hex(fingerprint);
      if (fingerprintHash !== challengeData.fp) {
        return json({ error: "PoW fingerprint 不匹配", code: "POW_FINGERPRINT_MISMATCH" }, 403);
      }
    }

    const finalHash = await sha256Hex(powInput(pow_challenge, fingerprint, powResult.nonce));
    const difficultyBits = challengeData.bits || POW_DIFFICULTY_BITS;
    if (!hasLeadingZeroBits(finalHash, difficultyBits)) return json({ error: "PoW 解无效" }, 403);
  }

  // 签发 token
  const fp = fingerprint.replace(/[^a-zA-Z0-9:_.,| -]/g, "").trim().slice(0, 512);
  if (fp.length < 32 || new Set(fp).size < 6) return json({ error: "fingerprint 太弱" }, 400);

  const viewerId = await fingerprintViewerId(secret, fp);
  const ipHash = (ipKnown && clientIp !== "unknown") ? (await hmacHex(secret, "ip:" + clientIp)).slice(0, 16) : "";
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ v: 2, sub: viewerId, ip: ipHash, iat: nowSec, exp: nowSec + 3600 });
  const encoded = base64UrlEncode(payload);
  const signature = await hmacSign(secret, encoded);

  return noStoreJson({ token: `${encoded}.${signature}`, viewer_id: viewerId, expires_in: 3600 }, cors);
}

async function fingerprintViewerId(secret, fingerprint) {
  return `fp_${(await hmacHex(secret, fingerprint)).slice(0, 32)}`;
}

async function verifyPowChallenge(challenge, secret) {
  if (!challenge || typeof challenge !== "string" || !challenge.includes(".")) return null;
  const [encoded, signature] = challenge.split(".", 2);
  if (!encoded || !signature) return null;
  if (await hmacSign(secret, encoded) !== signature) return null;

  let payload;
  try { payload = JSON.parse(base64UrlDecode(encoded)); } catch { return null; }
  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload || payload.v !== 2 || payload.alg !== POW_ALGORITHM) return null;
  if (typeof payload.exp !== "number" || payload.exp < nowSec) return null;
  if (typeof payload.iat !== "number" || payload.iat > nowSec + 30) return null;
  if (typeof payload.r !== "string" || !/^[a-f0-9]{64}$/.test(payload.r)) return null;
  const bits = Number(payload.bits);
  if (!Number.isFinite(bits) || bits < 12 || bits > 24) return null;
  return {
    bits,
    fp: sanitizePowFingerprintHash(payload.fp || ""),
  };
}

function sanitizePowFingerprintHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : "";
}

function powInput(challenge, fingerprint, nonce) {
  return `${POW_ALGORITHM}:${challenge}:${fingerprint}:${nonce}`;
}

function hasLeadingZeroBits(hex, bits) {
  const fullNibbles = Math.floor(bits / 4);
  if (!hex.startsWith("0".repeat(fullNibbles))) return false;
  const remainder = bits % 4;
  if (remainder === 0) return true;
  const next = parseInt(hex[fullNibbles] || "f", 16);
  return next < (1 << (4 - remainder));
}

// ── 安全响应头（对所有响应生效）──
function applySecurityHeaders(response, cors = null) {
  if (response.status === 101) return response;
  try {
    setSecurityHeaders(response.headers, cors);
    return response;
  } catch {}

  const headers = new Headers(response.headers);
  setSecurityHeaders(headers, cors);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function setSecurityHeaders(headers, cors = null) {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  if (cors) {
    for (const [key, value] of Object.entries(cors)) {
      if (value) headers.set(key, value);
    }
  }
  headers.delete("Server");
}

function getEdgeCache() {
  if (typeof cache !== "undefined" && cache) return cache;
  if (typeof caches !== "undefined" && caches.default) return caches.default;
  return null;
}

async function cacheGet(edgeCache, key) {
  if (typeof edgeCache.get === "function") return edgeCache.get(key);
  if (typeof edgeCache.match === "function") return edgeCache.match(key);
  return null;
}

async function cachePut(edgeCache, key, response) {
  if (typeof edgeCache.put === "function") return edgeCache.put(key, response);
  return null;
}
// ══════════════════════════════════════════════════════════════

async function handleCachedRead(request, origin, pathname, secret, cacheMeta = getCacheMeta(pathname, request), cors = null) {
  const ttl = cacheMeta.ttl;
  const cacheKey = `http://edge-cache${pathname}${new URL(request.url).search}`;
  const edgeCache = getEdgeCache();
  let verified = null;
  if (isAuthEndpoint(pathname)) {
    const clientIp = getClientIpFromHeaders(request.headers);
    const token = extractViewerToken(request);
    verified = token && secret ? await verifyViewerToken(token, secret, clientIp) : null;
    if (!verified) return jsonResponse({ error: "需要 viewer token" }, 403, cors);
    if (!allowMemoryRate("r_vr", verified.viewerId, RATE_VIEWER)) {
      return jsonResponse({ error: "限流" }, 429, cors);
    }
  }

  if (ttl > 0 && edgeCache) {
    try {
      const cached = await cacheGet(edgeCache, cacheKey);
      if (cached) return applySecurityHeaders(withEdgeCacheHeaders(cached, cacheMeta, "HIT"), cors);
    } catch {}
  }

  const originHeaders = new Headers(request.headers);
  originHeaders.set("X-Forwarded-For", getClientIpFromHeaders(request.headers));
  originHeaders.set("X-Real-IP", getClientIpFromHeaders(request.headers));
  if (secret) originHeaders.set("X-Edge-Internal", await hmacHex(secret, "edge-internal"));
  if (verified && secret) {
    originHeaders.set("X-Edge-Verified", "true");
    originHeaders.set("X-Edge-Viewer-Id", verified.viewerId);
    originHeaders.set("X-Edge-Signature", await hmacHex(secret, "edge:" + verified.viewerId));
  }
  const originResp = await withTimeout(
    fetch(originUrl(origin, pathname, new URL(request.url).search), {
      headers: originHeaders,
    }).catch(() => new Response("Origin Fetch Failed", { status: 502 })),
    8000,
    new Response("Gateway Timeout", { status: 504 }),
  );
  if (!originResp.ok) return applySecurityHeaders(originResp, cors);

  const response = applySecurityHeaders(withEdgeCacheHeaders(originResp, cacheMeta, ttl > 0 ? "MISS" : "BYPASS"), cors);

  if (ttl > 0 && edgeCache) {
    try { await cachePut(edgeCache, cacheKey, response.clone()); } catch {}
  }
  return response;
}

// ══════════════════════════════════════════════════════════════
// Token 验证 + 穿透
// ══════════════════════════════════════════════════════════════

async function handleAuthenticatedRequest(request, origin, clientIp, secret, cors = null) {
  if (!secret) return passthroughSigned(request, origin, clientIp, secret, cors);

  const token = extractViewerToken(request);
  if (token) {
    const verified = await verifyViewerToken(token, secret, clientIp);
    if (verified) {
      // 限流 60/min/viewer
      const kv = getEdgeKV();
      if (kv && !(await allowRate(kv, "vr", verified.viewerId, RATE_VIEWER))) {
        return jsonResponse({ error: "限流" }, 429, cors);
      }

      const headers = new Headers(request.headers);
      headers.set("X-Edge-Verified", "true");
      headers.set("X-Edge-Viewer-Id", verified.viewerId);
      headers.set("X-Edge-Signature", await hmacHex(secret, "edge:" + verified.viewerId));
      headers.set("X-Real-IP", clientIp);
      headers.set("X-Forwarded-For", clientIp);
      headers.set("X-Edge-Internal", await hmacHex(secret, "edge-internal"));

      const resp = await fetch(originUrl(origin, getPath(request), new URL(request.url).search), {
        method: request.method, headers,
        body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
      });

      const cacheMeta = getCacheMeta(getPath(request), request);
      if (request.method === "GET" && resp.ok && cacheMeta.tags && cacheMeta.tags.length) {
        return applySecurityHeaders(withEdgeCacheHeaders(resp, cacheMeta, "PASS"), cors);
      }
      return applySecurityHeaders(resp, cors);
    }
    ignoreRequestBody(request);
    return jsonResponse({ error: "token 无效" }, 403, cors);
  }

  const path = getPath(request);
  if (isAuthEndpoint(path)) {
    ignoreRequestBody(request);
    return jsonResponse({ error: "需要 viewer token" }, 403, cors);
  }
  return passthroughSigned(request, origin, clientIp, secret, cors);
}

// ══════════════════════════════════════════════════════════════
// 工具函数
// ══════════════════════════════════════════════════════════════

function getPath(request) { return new URL(request.url).pathname; }

function ignoreRequestBody(request) {
  try {
    if (request && typeof request.ignore === "function") request.ignore();
  } catch {}
}

function originUrl(origin, pathname, search = "") {
  const base = origin.endsWith("/") ? origin : `${origin}/`;
  const path = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  const query = search && !search.startsWith("?") ? `?${search}` : search;
  const url = new URL(`${path}${query || ""}`, base);
  return url.href;
}

function passthrough(request, origin, clientIp, cors = null) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  if (clientIp) headers.set("X-Real-IP", clientIp);
  if (clientIp) headers.set("X-Forwarded-For", clientIp);
  return withTimeout(
    fetch(originUrl(origin, url.pathname, url.search), {
      method: request.method, headers,
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
    }).catch(() => new Response("Origin Fetch Failed", { status: 502 })),
    8000, // below ESA 10s gateway timeout
    new Response("Gateway Timeout", { status: 504 }),
  ).then((response) => applySecurityHeaders(response, cors));
}
async function passthroughSigned(request, origin, clientIp, secret, cors = null) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  if (clientIp) headers.set("X-Real-IP", clientIp);
  if (clientIp) headers.set("X-Forwarded-For", clientIp);
  if (secret) headers.set("X-Edge-Internal", await hmacHex(secret, "edge-internal"));
  return withTimeout(
    fetch(originUrl(origin, url.pathname, url.search), {
      method: request.method, headers,
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
    }).catch(() => new Response("Origin Fetch Failed", { status: 502 })),
    8000, // below ESA 10s gateway timeout
    new Response("Gateway Timeout", { status: 504 }),
  ).then((response) => applySecurityHeaders(response, cors));
}


function withEdgeCacheHeaders(response, cacheMeta, edgeState) {
  const headers = new Headers(response.headers);
  if (cacheMeta.tags && cacheMeta.tags.length) {
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
  if (p === "/api/weekly-summary") return { ttl: 60, tags: ["weekly-summary", `weekly-summary-${url.searchParams.get("week_start") || url.searchParams.get("date") || "current"}`] };
  if (p === "/api/summary-settings") return { ttl: 0, tags: ["summary-settings"] };
  if (p === "/api/ai-config/test") return { ttl: 0, tags: ["ai-config"] };
  if (p === "/api/ai-config") return { ttl: 0, tags: ["ai-config"] };
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
    p === "/api/messages/private" ||
    p === "/api/messages/viewer/history";
}

function isViewerWriteEndpoint(p) {
  return p === "/api/messages/public" ||
    p === "/api/messages/private" ||
    p === "/api/messages/viewer/delete" ||
    p === "/api/push/subscribe" ||
    p === "/api/push/unsubscribe";
}

function isEdgeAuthFlow(p, method) {
  return (p === "/api/pow/challenge" && method === "GET") ||
    (p === "/api/token/issue" && method === "POST");
}

function hasEndpointRateLimit(p, method) {
  return isEdgeAuthFlow(p, method) ||
    (method === "POST" && isViewerWriteEndpoint(p)) ||
    (method === "GET" && isAuthEndpoint(p)) ||
    p === "/api/ws";
}

function isProtectedEdgeEndpoint(p, method) {
  return isEdgeAuthFlow(p, method) ||
    p === "/api/ws" ||
    (method === "POST" && isViewerWriteEndpoint(p)) ||
    (method === "GET" && isAuthEndpoint(p));
}

function usesEdgeReadBudget(pathname, method, request) {
  if (method !== "GET") return false;
  const cacheMeta = getCacheMeta(pathname, request);
  return cacheMeta.ttl > 0 || (cacheMeta.tags && cacheMeta.tags.length > 0);
}

function isLocalIp(ip) {
  if (!ip) return false;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" ||
    ip.startsWith("192.168.") || ip.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

function extractViewerToken(request) {
  const auth = request.headers.get("authorization");
  const match = auth ? auth.match(/^Bearer\s+(.+)$/i) : null;
  if (match && match[1]) return match[1];
  return new URL(request.url).searchParams.get("viewer_token");
}

function extractBearerToken(request) {
  const auth = request.headers.get("authorization");
  const match = auth ? auth.match(/^Bearer\s+(.+)$/i) : null;
  return match && match[1] ? match[1].trim() : "";
}

function parseDeviceTokenList(raw) {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .slice(0, MAX_DEVICE_TOKENS)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.includes(":") ? entry.split(":")[0] : entry)
    .filter(Boolean);
}

function isDeviceEndpoint(p, method) {
  if (method === "GET" && (p === "/api/messages/public" || p === "/api/health-data" || p === "/api/location")) return true;
  if (p === "/api/summary-settings") return true;
  if (p === "/api/ai-config/test") return true;
  if (p === "/api/ai-config") return true;
  if ((p === "/api/daily-summary" || p === "/api/weekly-summary") && method === "POST") return true;
  return p === "/api/report" ||
    p === "/api/supervision/ack" ||
    p === "/api/health-data" ||
    p === "/api/location" ||
    p === "/api/messages" ||
    p === "/api/messages/history" ||
    p === "/api/messages/reply" ||
    p === "/api/messages/delete" ||
    p === "/api/messages/remark" ||
    p === "/api/messages/block" ||
    p === "/api/messages/unblock" ||
    p === "/api/messages/viewer/delete" ||
     p === "/api/health-webhook" ||
    p === "/api/device";
}

async function isDeviceTokenRequest(request, secret, rawTokens, rawHashes) {
  const token = extractBearerToken(request);
  if (!token) return false;

  const tokens = parseDeviceTokenList(rawTokens);
  if (tokens.includes(token)) return true;

  if (!secret || !rawHashes) return false;
  const expected = new Set(rawHashes.split(/[\s,]+/).slice(0, MAX_DEVICE_TOKENS).map((v) => v.trim()).filter(Boolean));
  if (expected.size === 0) return false;
  const hash = await hmacHex(secret, "device:" + token);
  return expected.has(hash) || expected.has(hash.slice(0, 32));
}

function base64UrlEncode(input) {
  return bytesToBase64Url(TEXT_ENCODER.encode(input));
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return TEXT_DECODER.decode(bytes);
}

function bytesToBase64Url(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
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
  const recent = url.searchParams.get("recent");
  if (recent === "1" || recent === "true") {
    return { ttl: 0, tags: ["public-messages", "public-messages-recent"] };
  }

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
  if (ts && Date.now() - ts > RATE_WINDOW * 1000) {
    return 0;
  }
  return parseInt(parts[0], 10) || 0;
}

async function edgeKvKey(prefix, value) {
  const source = `${prefix}:${value}`;
  const digest = await sha256Hex(source);
  return `${prefix}_${digest.slice(0, 32)}`;
}

function allowMemoryRate(prefix, identity, limit) {
  const key = `${prefix}:${identity}`;
  const now = Date.now();
  if (memoryRate.size > 5000) {
    for (const itemKey of Array.from(memoryRate.keys())) {
      const item = memoryRate.get(itemKey);
      if (!item || item.resetAt <= now) memoryRate.delete(itemKey);
    }
  }
  const entry = memoryRate.get(key);
  if (!entry || entry.resetAt <= now) {
    memoryRate.set(key, { count: 1, resetAt: now + RATE_WINDOW * 1000 });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

async function allowRate(kv, prefix, identity, limit) {
  const cleanIdentity = String(identity || "unknown");
  const key = await edgeKvKey(`r_${prefix}`, cleanIdentity);
  if (!kv) return allowMemoryRate(`r_${prefix}`, cleanIdentity, limit);
  try {
    const current = await kvGetNumber(kv, key);
    if (current >= limit) return false;
    await kvPut(kv, key, String(current + 1), RATE_WINDOW);
    return true;
  } catch {
    return allowMemoryRate(`r_${prefix}`, cleanIdentity, limit);
  }
}

async function kvGet(kv, key) {
  return await kv.get(key, { type: "text" }) || null;
}

async function kvPut(kv, key, value, ttl = RATE_WINDOW) {
  try { await kv.put(key, `${value}:${Date.now()}`, { expirationTtl: ttl }); } catch {}
}

// ── HMAC (WebCrypto) ──

async function sha256Hex(data) {
  const hash = await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(data));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacKey(secret) {
  const cached = hmacKeyCache.get(secret);
  if (cached) return cached;
  if (hmacKeyCache.size >= 8) hmacKeyCache.clear();
  const imported = crypto.subtle.importKey("raw", TEXT_ENCODER.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  hmacKeyCache.set(secret, imported);
  try {
    return await imported;
  } catch (err) {
    hmacKeyCache.delete(secret);
    throw err;
  }
}

async function hmacBytes(secret, data) {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), TEXT_ENCODER.encode(data));
  return new Uint8Array(sig);
}

async function hmacHex(secret, data) {
  return Array.from(await hmacBytes(secret, data)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSign(secret, data) {
  return bytesToBase64Url(await hmacBytes(secret, data));
}

// ── 响应 ──

function jsonResponse(data, status = 200, cors = null) {
  return applySecurityHeaders(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...(cors || {}) } }), cors);
}

function noStoreJson(data, cors = null) {
  return applySecurityHeaders(new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0, s-maxage=0",
      "Pragma": "no-cache",
      "Expires": "0",
      "CDN-Cache-Control": "no-store", "Surrogate-Control": "no-store",
      ...(cors || {}),
    },
  }), cors);
}

function corsHeaders(request, pathname, method, allowedOrigins = "") {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
  };
  if (isPublicCorsEndpoint(pathname, method)) {
    headers["Access-Control-Allow-Origin"] = "*";
    return headers;
  }

  const origin = request.headers.get("origin") || "";
  if (origin && isAllowedCorsOrigin(origin, allowedOrigins)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

function isPublicCorsEndpoint(pathname, method) {
  return pathname === "/api/current" ||
    pathname === "/api/timeline" ||
    pathname === "/api/health" ||
    (pathname === "/api/daily-summary" && method === "GET") ||
    (pathname === "/api/weekly-summary" && method === "GET") ||
    pathname === "/api/config" ||
    pathname === "/api/push/vapid-public-key" ||
    pathname === "/api/pow/challenge" ||
    pathname === "/api/token/issue" ||
    (method === "GET" && (
      pathname === "/api/messages/public" ||
      pathname === "/api/health-data" ||
      pathname === "/api/location"
    ));
}

function isAllowedCorsOrigin(origin, allowedOrigins) {
  const items = String(allowedOrigins || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 50);
  if (!items.length) return false;
  return items.includes(origin);
}
