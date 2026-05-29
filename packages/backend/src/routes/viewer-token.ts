import { issueViewerToken, issuePowChallenge, verifyPowSolution, getTlsFingerprint, isLocalIp } from "../services/viewer-auth";
import { noStore } from "../services/cdn";

// GET /api/pow/challenge — issue a PoW challenge
export function handlePowChallenge(req: Request, ipHint: string): Response {
  if (isLocalIp(ipHint)) {
    return Response.json({ skip: true, message: "Local IP — PoW not required" });
  }
  const { challenge, difficulty } = issuePowChallenge(ipHint);
  return noStore(Response.json({ challenge, difficulty, expiresIn: 300 }));
}

// POST /api/token/issue — require PoW + JA3 for non-local IPs
export async function handleViewerTokenIssue(req: Request, ipHint: string): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // JA3/JA4 check: reject non-browser TLS fingerprints (non-local only)
  const tlsFp = getTlsFingerprint(req);
  if (!isLocalIp(ipHint) && tlsFp) {
    // Known bot TLS fingerprints (empty or suspicious)
    const knownBotFps = ["", "no-tls"];
    if (knownBotFps.includes(tlsFp.toLowerCase())) {
      return Response.json({ error: "Suspicious TLS fingerprint" }, { status: 403 });
    }
  }

  // PoW verification: required for non-local IPs
  if (!isLocalIp(ipHint)) {
    const { pow_challenge, pow_nonce } = body;
    if (!pow_challenge || !pow_nonce) {
      return Response.json({ error: "PoW challenge and nonce required", code: "POW_REQUIRED" }, { status: 403 });
    }
    const powValid = await verifyPowSolution(pow_challenge, pow_nonce, ipHint);
    if (!powValid) {
      return Response.json({ error: "Invalid PoW solution", code: "POW_INVALID" }, { status: 403 });
    }
  }

  const issued = issueViewerToken(body.fingerprint, ipHint);
  if (!issued.token) {
    return Response.json({ error: issued.error || "token issue failed" }, { status: issued.status || 400 });
  }
  return noStore(Response.json({
    token: issued.token,
    viewer_id: issued.viewerId,
    expires_in: 3600,
  }));
}
