import { issueViewerToken, issuePowChallenge, verifyPowSolution, getTlsFingerprint, isLocalIp, isEdgeMode } from "../services/viewer-auth";
import { noStore } from "../services/cdn";

// GET /api/pow/challenge — issue a PoW challenge
export function handlePowChallenge(req: Request, ipHint: string): Response {
  // Edge mode: PoW handled by ESA edge function, return skip
  if (isEdgeMode()) {
    return Response.json({ skip: true, message: "Edge mode — PoW handled at edge" });
  }
  // Skip PoW for local IPs and unknown IPs (PoW is IP-bound, can't work without valid IP)
  if (!ipHint || ipHint === "unknown" || isLocalIp(ipHint)) {
    return Response.json({ skip: true, message: "Local IP — PoW not required" });
  }
  const result = issuePowChallenge(ipHint);
  if ("error" in result) {
    return noStore(Response.json({ skip: true, message: result.error }));
  }
  return noStore(Response.json({ challenge: result.challenge, difficulty: result.difficulty, expiresIn: 300 }));
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
  const ipKnown2 = ipHint && ipHint !== "unknown";
  if (ipKnown2 && !isLocalIp(ipHint) && tlsFp) {
    // Known bot TLS fingerprints (empty or suspicious)
    const knownBotFps = ["", "no-tls"];
    if (knownBotFps.includes(tlsFp.toLowerCase())) {
      return Response.json({ error: "Suspicious TLS fingerprint" }, { status: 403 });
    }
  }

  // PoW verification: required for non-local IPs with known IP
  // Skip PoW when IP is unknown (empty/unknown) since PoW is IP-bound and can't be verified
  const ipKnown = ipHint && ipHint !== "unknown";
  if (ipKnown && !isLocalIp(ipHint) && !isEdgeMode()) {
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
