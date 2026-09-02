import { authenticateToken } from "../middleware/auth";
import { ingestAccountingBills } from "../services/accounting-bills";
import { readJsonObjectRequest } from "../services/request-body";

const MAX_ACCOUNTING_UPLOAD_BYTES = 512 * 1024;

export async function handleAccountingBillsUpload(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device || device.platform !== "android") {
    return Response.json({ error: "android_device_token_required" }, { status: 401 });
  }
  const parsed = await readJsonObjectRequest(req, { maxBytes: MAX_ACCOUNTING_UPLOAD_BYTES });
  if (!parsed.ok) return parsed.response;

  try {
    return Response.json({
      ok: true,
      ...ingestAccountingBills(device.device_id, parsed.body),
    });
  } catch (error) {
    const code = error instanceof Error && /^[a-z][a-z0-9_]{2,80}$/.test(error.message)
      ? error.message
      : "invalid_accounting_payload";
    return Response.json({ error: code }, { status: 400 });
  }
}
