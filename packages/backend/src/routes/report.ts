import { authenticateToken } from "../middleware/auth";
import { processReportPayload } from "../services/device-status-handler";

/**
 * v1 HTTP report endpoint — legacy path still used by older clients
 * and the LSP direct-upload mode. Internally delegates to the shared
 * processReportPayload so WebSocket (v2) and HTTP stay byte-compatible.
 */
export async function handleReport(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body !== "object" || Array.isArray(body) || body === null) {
    return Response.json({ error: "Invalid payload" }, { status: 400 });
  }

  const appId = typeof body.app_id === "string" ? body.app_id.trim() : "";
  if (!appId) {
    return Response.json({ error: "app_id required" }, { status: 400 });
  }

  try {
    processReportPayload(body as Record<string, unknown>, device);
  } catch (e: any) {
    console.error("[report] v1 handler error:", e.message);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }

  return Response.json({ ok: true });
}
