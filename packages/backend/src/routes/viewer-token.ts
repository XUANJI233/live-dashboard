const POW_DISABLED = /^(1|true|yes)$/i.test(process.env.POW_DISABLED || "");
const TLS_CHECK_DISABLED = /^(1|true|yes)$/i.test(process.env.TLS_CHECK_DISABLED || "");

import { issueViewerToken, issuePowChallenge, verifyPowSolution, getTlsFingerprint, isLocalIp } from "../services/viewer-auth";
import { noStore } from "../services/cdn";

// GET /api/pow/challenge — issue a PoW challenge
export function handlePowChallenge(req: Request, ipHint: string): Response {
  // Auto-detect: if request already came through ESA edge function, skip PoW
  if (req.headers.get("x-edge-verified") === "true") {
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

// POST /api/token/issue — require PoW + JA4 for non-local IPs (skip in edge/CDN mode)
export async function handleViewerTokenIssue(req: Request, ipHint: string): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const ipKnown = ipHint && ipHint !== "unknown";
  const edgeMode = req.headers.get("x-edge-internal") != null || req.headers.get("x-edge-verified") === "true";

  // JA4 check: reject non-browser TLS fingerprints (non-local, non-edge only)
  // In CDN/edge mode TLS is terminated at the edge, so JA4 isn't available — skip.
  if (!TLS_CHECK_DISABLED && !edgeMode && ipKnown && !isLocalIp(ipHint)) {
    const tlsFp = getTlsFingerprint(req);
    if (tlsFp) {
      const knownBotFps = ["", "no-tls"];
      if (knownBotFps.includes(tlsFp.toLowerCase())) {
        return Response.json({ error: "Suspicious TLS fingerprint" }, { status: 403 });
      }
    }
  }

  // PoW verification: required for non-local IPs with known IP
  // Skip PoW when IP is unknown (empty/unknown) since PoW is IP-bound and can't be verified
  const ipKnown = ipHint && ipHint !== "unknown";
  // Skip PoW if already verified by ESA edge function
  const edgeVerified = req.headers.get("x-edge-verified") === "true";
  if (!POW_DISABLED && ipKnown && !isLocalIp(ipHint) && !edgeVerified) {
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
