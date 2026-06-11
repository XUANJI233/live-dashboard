const POW_DISABLED = /^(true|yes)$/i.test(process.env.POW_DISABLED || "");
const TLS_CHECK_DISABLED = /^(true|yes)$/i.test(process.env.TLS_CHECK_DISABLED || "");
const EDGE_MODE = /^true$/i.test(process.env.EDGE_MODE || "");

import { issueViewerToken, issuePowChallenge, verifyPowSolution, getTlsFingerprint, isLocalIp, edgeViewerIdentity } from "../services/viewer-auth";
import { noStore } from "../services/cdn";
import { hmacTitle } from "../db";

// GET /api/pow/challenge — issue a PoW challenge
export function handlePowChallenge(req: Request, ipHint: string): Response {
  // In edge mode, skip origin PoW only for HMAC-signed edge requests.
  // Direct-to-origin traffic must still pass the origin PoW path.
  if (EDGE_MODE && isEdgeInternalRequest(req)) {
    return noStore(Response.json({ skip: true, message: "Edge mode - PoW handled at edge" }));
  }
  // Skip PoW for local IPs and unknown IPs (PoW is IP-bound, can't work without valid IP)
  if (!ipHint || ipHint === "unknown" || isLocalIp(ipHint)) {
    return noStore(Response.json({ skip: true, message: "Local IP - PoW not required" }));
  }
  const result = issuePowChallenge(ipHint);
  if ("error" in result) {
    return noStore(Response.json({ skip: true, message: result.error }));
  }
  return noStore(Response.json({ challenge: result.challenge, difficulty: result.difficulty, segments: result.segments, expiresIn: 300 }));
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

  const edgeTrusted = isEdgeInternalRequest(req) || edgeViewerIdentity(req) !== null;

  // JA4 check: reject non-browser TLS fingerprints (non-local, non-edge only).
  // In CDN/edge mode TLS is terminated at the edge, but only HMAC-signed edge
  // requests may skip this origin-side check.
  if (!TLS_CHECK_DISABLED && !(EDGE_MODE && edgeTrusted) && ipKnown && !isLocalIp(ipHint)) {
    const tlsFp = getTlsFingerprint(req);
    if (tlsFp) {
      const knownBotFps = ["", "no-tls"];
      if (knownBotFps.includes(tlsFp.toLowerCase())) {
        return Response.json({ error: "Suspicious TLS fingerprint" }, { status: 403 });
      }
    }
  }

  // PoW verification: required for non-local IPs with known IP.
  // Skip PoW only when the request is actually signed by the edge.
  if (!POW_DISABLED && !(EDGE_MODE && edgeTrusted) && ipKnown && !isLocalIp(ipHint)) {
    let pow_challenge = body.pow_challenge;
    let pow_nonce = body.pow_nonce;
    let pow_last_hash = "";
    // Support new memory-PoW result format (pow_result JSON with nonce + lastHash)
    if (!pow_nonce && body.pow_result) {
      try {
        const r = JSON.parse(body.pow_result);
        pow_nonce = r.nonce;
        pow_last_hash = typeof r.lastHash === "string" ? r.lastHash : "";
      } catch {}
    }
    if (!pow_challenge || !pow_nonce) {
      return Response.json({ error: "PoW challenge and nonce required", code: "POW_REQUIRED" }, { status: 403 });
    }
    const powValid = await verifyPowSolution(pow_challenge, pow_nonce, ipHint, pow_last_hash);
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

function isEdgeInternalRequest(req: Request): boolean {
  const sig = req.headers.get("x-edge-internal");
  return !!sig && sig === hmacTitle("edge-internal");
}
