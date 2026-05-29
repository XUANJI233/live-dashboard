import { hmacTitle } from "../db";
import { randomBytes, createHash } from "crypto";

const TOKEN_TTL_SECONDS = 60 * 60;
const MIN_FINGERPRINT_LENGTH = 32; // FingerprintJS visitorId is 32-char hex
const MIN_FINGERPRINT_UNIQUE = 6;  // hex has 16 chars, 6 is reasonable
const POW_DIFFICULTY_HEX = 4;      // 4 leading hex zeros = 16 bits of work
const POW_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const VIEWER_TOKEN_RATE_LIMIT = 120;
const MAX_POW_CHALLENGES = 10000;  // limit memory usage

// ── In-memory stores ──
const powChallenges = new Map<string, { ip: string; createdAt: number }>();
const issueRate = new Map<string, { count: number; resetAt: number }>();
const viewerTokenRate = new Map<string, { count: number; resetAt: number }>();

// ── Cleanup (5 min) ──
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of powChallenges) if (now - v.createdAt > POW_CHALLENGE_TTL_MS) powChallenges.delete(k);
  for (const [k, v] of issueRate) if (v.resetAt < now) issueRate.delete(k);
  for (const [k, v] of viewerTokenRate) if (v.resetAt < now) viewerTokenRate.delete(k);
}, 300_000).unref();

// ── Helpers ──
function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function unbase64url(input: string): string {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
function sign(payload: string): string {
  return base64url(hmacTitle(payload));
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
  // Reject empty IP — must have a valid client IP
  if (!ip || ip === "unknown") {
    return { error: "Unable to determine client IP", status: 400 };
  }

  const fingerprint = cleanFingerprint(fingerprintValue);
  if (fingerprint.length < MIN_FINGERPRINT_LENGTH || new Set(fingerprint).size < MIN_FINGERPRINT_UNIQUE) {
    return { error: "fingerprint too weak", status: 400 };
  }

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
  const ih = ipHash(ip);
  const payload = {
    sub: fingerprintId(fingerprint),
    ip: ih,
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

export function verifyViewerToken(token: string | null | undefined, ip?: string): ViewerIdentity | null {
  if (!token || !token.includes(".")) return null;
  const [encoded, signature] = token.split(".", 2);
  if (!encoded || !signature || sign(encoded) !== signature) return null;
  try {
    const payload = JSON.parse(unbase64url(encoded)) as { sub?: unknown; exp?: unknown; ip?: unknown };
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!/^fp_[a-f0-9]{32}$/.test(payload.sub)) return null;
    // IP binding check
    const tokenIpHash = typeof payload.ip === "string" ? payload.ip : "";
    if (tokenIpHash && ip && tokenIpHash !== ipHash(ip)) return null;
    return { viewerId: payload.sub, exp: payload.exp, ipHash: tokenIpHash };
  } catch {
    return null;
  }
}

// ── PoW Challenge ──
export function issuePowChallenge(ip: string): { challenge: string; difficulty: number } | { error: string; status: number } {
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
  powChallenges.set(challenge, { ip, createdAt: Date.now() });
  return { challenge, difficulty: POW_DIFFICULTY_HEX };
}

export function verifyPowSolution(challenge: string, nonce: string, ip: string): boolean {
  const entry = powChallenges.get(challenge);
  if (!entry) return false;
  if (entry.ip !== ip) return false;
  if (Date.now() - entry.createdAt > POW_CHALLENGE_TTL_MS) {
    powChallenges.delete(challenge);
    return false;
  }
  const input = challenge + nonce;
  const hashHex = createHash("sha256").update(input).digest("hex");
  powChallenges.delete(challenge);
  return hashHex.startsWith("0".repeat(POW_DIFFICULTY_HEX));
}

// ── TLS Fingerprint ──
export function getTlsFingerprint(req: Request): string | null {
  return req.headers.get("x-ja3-fingerprint") || req.headers.get("x-ja4") || null;
}

// ── Token extraction ──
export function viewerTokenFromRequest(req: Request): string | null {
  const auth = req.headers.get("authorization");
  const match = auth?.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) return match[1];
  const url = new URL(req.url);
  return url.searchParams.get("viewer_token");
}