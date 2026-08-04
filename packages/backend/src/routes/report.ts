import { authenticateToken } from "../middleware/auth";
import { processReportPayload, ReportPayloadError } from "../services/device-status-handler";
import { syncCurrentSupervisionPolicyForDevice } from "../services/supervision-policy-control";
import { requestSupervisionCheckFromReportPayload } from "../services/supervision-report-trigger";
import { readJsonObjectRequest } from "../services/request-body";

const MAX_REPORT_JSON_BYTES = 1024 * 1024;

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

  const parsed = await readJsonObjectRequest(req, { maxBytes: MAX_REPORT_JSON_BYTES });
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const appId = typeof body.app_id === "string" ? body.app_id.trim() : "";
  const sleeping = body.extra && typeof body.extra === "object" && !Array.isArray(body.extra)
    ? (body.extra as Record<string, unknown>).sleeping === true
    : false;
  if (!appId && !sleeping) {
    return Response.json({ error: "app_id required" }, { status: 400 });
  }

  try {
    processReportPayload(body as Record<string, unknown>, device);
    requestSupervisionCheckFromReportPayload(body as Record<string, unknown>, device);
    syncCurrentSupervisionPolicyForDevice(device.device_id);
  } catch (e: any) {
    if (e instanceof ReportPayloadError) {
      return Response.json({ error: e.message, code: e.code }, { status: e.status });
    }
    console.error("[report] v1 handler error:", e.message);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }

  return Response.json({ ok: true });
}
