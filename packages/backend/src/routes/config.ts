import { getSiteConfig } from "../services/site-config";
import { withCdnHeaders } from "../services/cdn";
import { edgeViewerIdentity, verifyViewerToken, viewerTokenFromRequest } from "../services/viewer-auth";

export function handleConfig(req?: Request): Response {
  const viewer = req ? (edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req))) : null;
  if (!viewer) return Response.json({ error: "Viewer token required" }, { status: 403 });
  return withCdnHeaders(Response.json(getSiteConfig()), ["config"], 60);
}
