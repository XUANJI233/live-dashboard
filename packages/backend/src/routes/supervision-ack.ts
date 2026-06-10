import { authenticateToken } from "../middleware/auth";
import {
  receiveDeviceCommandReceipt,
  receiveDeviceCommandResult,
} from "../services/supervision-ack";

const MAX_ACK_REQUEST_BYTES = 32 * 1024;

export async function handleSupervisionAck(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized", received: false }, { status: 401 });

  const length = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > MAX_ACK_REQUEST_BYTES) {
    return Response.json({ error: "Request too large", received: false }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON", received: false }, { status: 400 });
  }

  const bodyType = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).type
    : "";
  if (bodyType === "device_command_receipt") {
    const receipt = receiveDeviceCommandReceipt(body, device);
    return Response.json(
      receipt.received
        ? { received: true, command_id: receipt.command_id, request_id: receipt.request_id }
        : { received: false, command_id: receipt.command_id, error: receipt.error ?? "invalid_receipt" },
      { status: receipt.received ? 200 : 400 },
    );
  }
  if (bodyType === "device_command_result") {
    const receipt = receiveDeviceCommandResult(body, device);
    return Response.json(
      receipt.received
        ? {
            received: true,
            command_id: receipt.command_id,
            request_id: receipt.request_id,
            result_id: receipt.result_id,
            duplicate: receipt.duplicate === true,
          }
        : { received: false, command_id: receipt.command_id, error: receipt.error ?? "invalid_result" },
      { status: receipt.received ? 200 : 400 },
    );
  }

  return Response.json(
    { received: false, error: "unsupported_ack_type" },
    { status: 400 },
  );
}
