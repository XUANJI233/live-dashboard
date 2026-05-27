import { hmacTitle } from "../db";

const TOKEN_TTL_SECONDS = 60 * 60;
const MIN_FINGERPRINT_LENGTH = 48;
const issueRate = new Map<string, { count: number; resetAt: number }>();

function base64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function unbase64url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
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

function checkIssueRate(key: string): boolean {
  const now = Date.now();
  const current = issueRate.get(key);
  if (!current || current.resetAt <= now) {
    issueRate.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (current.count >= 12) return false;
  current.count += 1;
  return true;
}

export interface ViewerIdentity {
  viewerId: string;
  exp: number;
}

export function issueViewerToken(fingerprintValue: unknown, ipHint: string): { token?: string; viewerId?: string; error?: string; status?: number } {
  const fingerprint = cleanFingerprint(fingerprintValue);
  if (fingerprint.length < MIN_FINGERPRINT_LENGTH || new Set(fingerprint).size < 12) {
    return { error: "fingerprint too weak", status: 400 };
  }
  if (!checkIssueRate(ipHint || fingerprint.slice(0, 64))) {
    return { error: "rate limited", status: 429 };
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: fingerprintId(fingerprint),
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };
  const encoded = base64url(JSON.stringify(payload));
  const token = `${encoded}.${sign(encoded)}`;
  return { token, viewerId: payload.sub };
}

export function verifyViewerToken(token: string | null | undefined): ViewerIdentity | null {
  if (!token || !token.includes(".")) return null;
  const [encoded, signature] = token.split(".", 2);
  if (!encoded || !signature || sign(encoded) !== signature) return null;
  try {
    const payload = JSON.parse(unbase64url(encoded)) as { sub?: unknown; exp?: unknown };
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!/^fp_[a-f0-9]{32}$/.test(payload.sub)) return null;
    return { viewerId: payload.sub, exp: payload.exp };
  } catch {
    return null;
  }
}

export function viewerTokenFromRequest(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) return match[1];
  const url = new URL(req.url);
  return url.searchParams.get("viewer_token");
}
