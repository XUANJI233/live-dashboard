import { hmacTitle } from "../db";
import { randomBytes, createHash } from "crypto";

const TOKEN_TTL_SECONDS = 60 * 60;
const MIN_FINGERPRINT_LENGTH = 32; // FingerprintJS visitorId is 32-char hex
const MIN_FINGERPRINT_UNIQUE = 6;  // hex has 16 chars, 6 is reasonable
const POW_DIFFICULTY_HEX = 4;      // 4 leading hex zeros = 16 bits of work
const POW_MEMORY_SEGMENTS = 16384; // 512 KB sequential memory chain, matches edge/frontend
const POW_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const VIEWER_TOKEN_RATE_LIMIT = 600;
const MAX_POW_CHALLENGES = 10000;  // limit memory usage
const VIEWER_IDENTITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_VIEWER_IDENTITY_KEYS = 50_000;

// ── In-memory stores ──
const powChallenges = new Map<string, { ip: string; ipUpdated: boolean; createdAt: number }>();
const issueRate = new Map<string, { count: number; resetAt: number }>();
const viewerTokenRate = new Map<string, { count: number; resetAt: number }>();
const powChallengeRate = new Map<string, { count: number; resetAt: number }>();
const fingerprintViewerIds = new Map<string, string>();
const ipViewerIds = new Map<string, string>();
const viewerAliases = new Map<string, string>();
const fingerprintSeenAt = new Map<string, number>();
const ipSeenAt = new Map<string, number>();
const aliasSeenAt = new Map<string, number>();

// ── Cleanup (5 min) ──
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of powChallenges) if (now - v.createdAt > POW_CHALLENGE_TTL_MS) powChallenges.delete(k);
  for (const [k, v] of issueRate) if (v.resetAt < now) issueRate.delete(k);
  for (const [k, v] of viewerTokenRate) if (v.resetAt < now) viewerTokenRate.delete(k);
  for (const [k, v] of powChallengeRate) if (v.resetAt < now) powChallengeRate.delete(k);
  cleanupViewerIdentityMaps(now);
}, 300_000).unref();

// ── Helpers ──
function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function unbase64url(input: string): string {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
function sign(payload: string): string {
  const hex = hmacTitle(payload);
  // 将 hex 字符串解码为字节，再转 Base64url
  return Buffer.from(hex, "hex")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function cleanFingerprint(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[^a-zA-Z0-9:_.,| -]/g, "").trim().slice(0, 512);
}
function fingerprintId(fingerprint: string): string {
  return `fp_${hmacTitle(fingerprint).slice(0, 32)}`;
}
function ipHash(ip: string): string {
  return hmacTitle("ip:" + ip).slice(0, 16);
}

function cleanupViewerIdentityMaps(now: number): void {
  cleanupLastSeenMap(fingerprintSeenAt, now, (key) => fingerprintViewerIds.delete(key));
  cleanupLastSeenMap(ipSeenAt, now, (key) => ipViewerIds.delete(key));
  cleanupLastSeenMap(aliasSeenAt, now, (key) => viewerAliases.delete(key));
}

function cleanupLastSeenMap(lastSeen: Map<string, number>, now: number, deleteValue: (key: string) => void): void {
  for (const [key, seenAt] of lastSeen) {
    if (now - seenAt > VIEWER_IDENTITY_TTL_MS) {
      lastSeen.delete(key);
      deleteValue(key);
    }
  }
  if (lastSeen.size <= MAX_VIEWER_IDENTITY_KEYS) return;
  const toDrop = [...lastSeen.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, lastSeen.size - MAX_VIEWER_IDENTITY_KEYS);
  for (const [key] of toDrop) {
    lastSeen.delete(key);
    deleteValue(key);
  }
}

function canonicalViewerId(viewerId: string): string {
  let current = viewerId;
  const seen = new Set<string>();
  while (viewerAliases.has(current) && !seen.has(current)) {
    seen.add(current);
    aliasSeenAt.set(current, Date.now());
    current = viewerAliases.get(current)!;
  }
  for (const item of seen) {
    viewerAliases.set(item, current);
    aliasSeenAt.set(item, Date.now());
  }
  return current;
}

function linkViewerIds(primary: string, secondary: string): string {
  const a = canonicalViewerId(primary);
  const b = canonicalViewerId(secondary);
  if (a === b) return a;
  const canonical = a < b ? a : b;
  const alias = canonical === a ? b : a;
  viewerAliases.set(alias, canonical);
  aliasSeenAt.set(alias, Date.now());
  return canonical;
}

function resolveViewerId(fingerprint: string, ip: string): { viewerId: string; ipHash: string } {
  const now = Date.now();
  const fpId = fingerprintId(fingerprint);
  const ih = (ip && ip !== "unknown") ? ipHash(ip) : "";
  const fpViewer = fingerprintViewerIds.get(fpId);
  const ipViewer = ih ? ipViewerIds.get(ih) : undefined;
  let viewerId = fpViewer || ipViewer || fpId;
  if (fpViewer && ipViewer) viewerId = linkViewerIds(fpViewer, ipViewer);
  viewerId = canonicalViewerId(viewerId);
  fingerprintViewerIds.set(fpId, viewerId);
  fingerprintSeenAt.set(fpId, now);
  if (ih) {
    ipViewerIds.set(ih, viewerId);
    ipSeenAt.set(ih, now);
  }
  return { viewerId, ipHash: ih };
}

// ── Local IP check ──
export function isLocalIp(ip: string): boolean {
  if (!ip) return false;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" ||
    ip.startsWith("192.168.") || ip.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

// ── Token encoding IP hash ──
export interface ViewerIdentity {
  viewerId: string;
  exp: number;
  ipHash: string;
}

export function issueViewerToken(fingerprintValue: unknown, ip: string): { token?: string; viewerId?: string; error?: string; status?: number } {
  const fingerprint = cleanFingerprint(fingerprintValue);
  if (fingerprint.length < MIN_FINGERPRINT_LENGTH || new Set(fingerprint).size < MIN_FINGERPRINT_UNIQUE) {
    return { error: "fingerprint too weak", status: 400 };
  }

  // Rate limit per IP only when IP is known
  const rateKey = ip;
  const now = Date.now();
  const current = issueRate.get(rateKey);
  if (current && current.resetAt > now && current.count >= 12) {
    return { error: "rate limited", status: 429 };
  }
  if (!current || current.resetAt <= now) {
    issueRate.set(rateKey, { count: 1, resetAt: now + 60_000 });
  } else {
    current.count++;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const identity = resolveViewerId(fingerprint, ip);
  const payload = {
    sub: identity.viewerId,
    ip: identity.ipHash,
    iat: nowSec,
    exp: nowSec + TOKEN_TTL_SECONDS,
  };
  const encoded = base64url(JSON.stringify(payload));
  const token = `${encoded}.${sign(encoded)}`;
  return { token, viewerId: payload.sub };
}

export function viewerTokenRateLimit(viewerId: string): boolean {
  const now = Date.now();
  const current = viewerTokenRate.get(viewerId);
  if (!current || current.resetAt <= now) {
    viewerTokenRate.set(viewerId, { count: 1, resetAt: now + 3600_000 });
    return true;
  }
  if (current.count >= VIEWER_TOKEN_RATE_LIMIT) return false;
  current.count++;
  return true;
}

// Per-IP rate limit for PoW challenge requests (30/min)
export function powChallengeRateLimit(ip: string): boolean {
  const now = Date.now();
  const current = powChallengeRate.get(ip);
  if (!current || current.resetAt <= now) {
    powChallengeRate.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (current.count >= 30) return false;
  current.count++;
  return true;
}

export function verifyViewerToken(token: string | null | undefined): ViewerIdentity | null {
  if (!token || !token.includes(".")) return null;
  const [encoded, signature] = token.split(".", 2);
  if (!encoded || !signature || sign(encoded) !== signature) return null;
  try {
    const payload = JSON.parse(unbase64url(encoded)) as { sub?: unknown; exp?: unknown; ip?: unknown };
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!/^fp_[a-f0-9]{32}$/.test(payload.sub)) return null;
    // IP hash is kept as an advisory signal only. Viewer identity is the browser
    // fingerprint hash so mobile networks/CDN edge changes do not split one viewer
    // into many counters.
    const tokenIpHash = typeof payload.ip === "string" ? payload.ip : "";
    return { viewerId: canonicalViewerId(payload.sub), exp: payload.exp, ipHash: tokenIpHash };
  } catch {
    return null;
  }
}

// ── PoW Challenge ──
export function issuePowChallenge(ip: string): { challenge: string; difficulty: number; segments: number } | { error: string; status: number } {
  if (!ip || ip === "unknown") {
    return { error: "Unable to determine client IP", status: 400 };
  }
  // Limit challenge count to prevent memory exhaustion
  if (powChallenges.size >= MAX_POW_CHALLENGES) {
    // Clean expired first
    const now = Date.now();
    for (const [key, val] of powChallenges) {
      if (now - val.createdAt > POW_CHALLENGE_TTL_MS) powChallenges.delete(key);
    }
    if (powChallenges.size >= MAX_POW_CHALLENGES) {
      return { error: "Too many pending challenges", status: 429 };
    }
  }
  const challenge = randomBytes(32).toString("hex");
  powChallenges.set(challenge, { ip, ipUpdated: false, createdAt: Date.now() });
  return { challenge, difficulty: POW_DIFFICULTY_HEX, segments: POW_MEMORY_SEGMENTS };
}

export function verifyPowSolution(challenge: string, nonce: string, ip: string, lastHash?: string): boolean {
  const entry = powChallenges.get(challenge);
  if (!entry) return false;
  if (Date.now() - entry.createdAt > POW_CHALLENGE_TTL_MS) {
    powChallenges.delete(challenge);
    return false;
  }
  // IP binding: allow one IP change (mobile networks / CDN edge switching)
  if (entry.ip !== ip) {
    if (entry.ipUpdated) return false; // second IP change → reject
    entry.ipUpdated = true;
    entry.ip = ip;
  }
  let hashHex = "";
  if (lastHash) {
    const firstHash = createHash("sha256").update(challenge).digest("hex");
    let chainHash = firstHash;
    for (let i = 1; i < POW_MEMORY_SEGMENTS; i += 1) {
      chainHash = createHash("sha256").update(chainHash).digest("hex");
    }
    if (chainHash !== lastHash) {
      powChallenges.delete(challenge);
      return false;
    }
    hashHex = createHash("sha256").update(firstHash + chainHash + nonce).digest("hex");
  } else {
    hashHex = createHash("sha256").update(challenge + nonce).digest("hex");
  }
  powChallenges.delete(challenge);
  return hashHex.startsWith("0".repeat(POW_DIFFICULTY_HEX));
}

// ── TLS Fingerprint (JA4) ──
export function getTlsFingerprint(req: Request): string | null {
  return req.headers.get("x-ja4") || req.headers.get("x-ja4-fingerprint") || req.headers.get("x-ja3-fingerprint") || null;
}

// ── Token extraction ──
// ── Edge verification (auto-detected, HMAC-signed) ──
// No env var needed: if X-Edge-Verified header is present and HMAC-valid, trust it.
// The edge function signs headers with HASH_SECRET, origin verifies.

export function edgeViewerIdentity(req: Request): ViewerIdentity | null {
  const verified = req.headers.get("x-edge-verified");
  if (verified !== "true") return null;
  const viewerId = req.headers.get("x-edge-viewer-id");
  const edgeSig = req.headers.get("x-edge-signature");
  if (!viewerId || !edgeSig) return null;
  if (!/^fp_[a-f0-9]{32}$/.test(viewerId)) return null;
  // Verify HMAC signature: edge signs "viewerId:timestamp" with HASH_SECRET
  const expectedSig = hmacTitle("edge:" + viewerId);
  if (edgeSig !== expectedSig) return null;
  return { viewerId, exp: Math.floor(Date.now() / 1000) + 3600, ipHash: "" };
}

// ── Token extraction ──
export function viewerTokenFromRequest(req: Request): string | null {
  const auth = req.headers.get("authorization");
  const match = auth?.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) return match[1];
  const url = new URL(req.url);
  return url.searchParams.get("viewer_token");
}
