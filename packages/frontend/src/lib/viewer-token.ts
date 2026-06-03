const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

export type TokenStatus = "pow" | "token" | "connecting";

interface ViewerIdentity {
  token: string;
  viewerId: string;
}

let fpPromise: Promise<string> | null = null;
let tokenPromise: Promise<ViewerIdentity> | null = null;

function cachedIdentity(): ViewerIdentity | null {
  if (typeof window === "undefined") return null;
  const token = localStorage.getItem("live-dashboard-viewer-token");
  const viewerId = localStorage.getItem("live-dashboard-viewer-id");
  const exp = Number(localStorage.getItem("live-dashboard-viewer-token-exp") || 0);
  if (token && viewerId && Date.now() < exp - 60_000) return { token, viewerId };
  if (token || viewerId || exp) {
    localStorage.removeItem("live-dashboard-viewer-token");
    localStorage.removeItem("live-dashboard-viewer-id");
    localStorage.removeItem("live-dashboard-viewer-token-exp");
  }
  return null;
}

export function getCachedViewerToken(): string | null {
  return cachedIdentity()?.token || null;
}

async function fingerprint(): Promise<string> {
  if (!fpPromise) {
    fpPromise = import("@fingerprintjs/fingerprintjs")
      .then((mod) => mod.default.load())
      .then((fp) => fp.get())
      .then((result) => result.visitorId);
  }
  return fpPromise;
}

async function solvePow(challenge: string, difficulty: number, segments: number = 16384): Promise<{ nonce: string; lastHash: string } | null> {
  const deadline = Date.now() + 10_000;

  // Phase 1: Build memory chain (512KB sequential SHA-256 — inherently serial)
  const chain: string[] = new Array(segments);
  chain[0] = await sha256Hex(challenge);
  for (let i = 1; i < segments; i++) {
    if (Date.now() > deadline) return null;
    chain[i] = await sha256Hex(chain[i - 1]);
  }
  const lastHash = chain[segments - 1];

  // Phase 2: Find nonce where SHA256(firstHash + lastHash + nonce) has N leading zeros
  const firstHash = chain[0];
  for (let nonce = 0; nonce < 10_000_000; nonce += 1) {
    if (Date.now() > deadline) return null;
    const hashHex = await sha256Hex(firstHash + lastHash + String(nonce));
    if (hashHex.startsWith("0".repeat(difficulty))) return { nonce: String(nonce), lastHash };
  }
  return null;
}

async function sha256Hex(data: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function ensureViewerToken(onStatus?: (status: TokenStatus) => void): Promise<ViewerIdentity> {
  const cached = cachedIdentity();
  if (cached) return cached;
  if (tokenPromise) return tokenPromise;

  tokenPromise = (async () => {
    onStatus?.("pow");
    const powRes = await fetch(`${API_BASE}/api/pow/challenge?_=${Date.now()}`);
    if (!powRes.ok) throw new Error("获取访客验证失败");
    const powData = await powRes.json();

    const body: Record<string, string> = { fingerprint: await fingerprint() };
    if (powData.challenge && !powData.skip) {
      const result = await solvePow(powData.challenge, powData.difficulty || 4, powData.segments || 16384);
      if (!result) throw new Error("访客验证超时，请重试");
      body.pow_challenge = powData.challenge;
      body.pow_result = JSON.stringify(result);
    }

    onStatus?.("token");
    const res = await fetch(`${API_BASE}/api/token/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "访客令牌领取失败");
    }

    const data = await res.json();
    const identity = { token: data.token as string, viewerId: data.viewer_id as string };
    localStorage.setItem("live-dashboard-viewer-token", identity.token);
    localStorage.setItem("live-dashboard-viewer-id", identity.viewerId);
    localStorage.setItem("live-dashboard-viewer-token-exp", String(Date.now() + Number(data.expires_in || 3600) * 1000));
    return identity;
  })();

  try {
    return await tokenPromise;
  } finally {
    tokenPromise = null;
  }
}
