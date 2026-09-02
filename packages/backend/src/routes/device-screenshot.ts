import { authenticateToken } from "../middleware/auth";
import { cleanIdentifier } from "../services/mcp-contracts";
import {
  maxScreenshotBytes,
  storeScreenshotUpload,
} from "../services/device-screenshot-store";
import { readLimitedRequestBytes } from "../services/request-body";

export async function handleDeviceScreenshotUpload(
  req: Request,
  screenshotIdValue: string,
): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return json({ received: false, error: "unauthorized" }, 401);
  if (req.method !== "POST") return json({ received: false, error: "method_not_allowed" }, 405);

  const screenshotId = cleanIdentifier(screenshotIdValue);
  const commandId = cleanIdentifier(req.headers.get("x-command-id"));
  if (!screenshotId || !commandId) {
    return json({ received: false, error: "screenshot_id_and_command_id_required" }, 400);
  }
  const contentType = (req.headers.get("content-type") || "").split(";", 1)[0]!.trim().toLowerCase();
  if (contentType !== "image/jpeg") {
    return json({ received: false, error: "unsupported_screenshot_type" }, 415);
  }

  const body = await readLimitedRequestBytes(req, maxScreenshotBytes(), {
    received: false,
    error: "screenshot_too_large",
  });
  if (!body.ok) return body.response;
  if (!isJpeg(body.bytes)) return json({ received: false, error: "invalid_screenshot_data" }, 400);

  const stored = storeScreenshotUpload({
    screenshotId,
    commandId,
    deviceId: device.device_id,
    mimeType: contentType,
    width: integerHeader(req, "x-screenshot-width"),
    height: integerHeader(req, "x-screenshot-height"),
    imageData: body.bytes,
  });
  if (!stored.stored) return json({ received: false, error: stored.error || "screenshot_upload_failed" }, 400);
  return json({
    received: true,
    screenshot_id: screenshotId,
    command_id: commandId,
  });
}

function integerHeader(req: Request, name: string): number {
  const value = Number.parseInt(req.headers.get(name) || "", 10);
  return Number.isInteger(value) ? value : 0;
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[bytes.byteLength - 2] === 0xff && bytes[bytes.byteLength - 1] === 0xd9;
}

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
