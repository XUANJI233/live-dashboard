import { authenticateToken } from "../middleware/auth";
import {
  receiveDeviceCommandReceipt,
  receiveDeviceCommandResult,
} from "../services/supervision-ack";
import { readJsonObjectRequest } from "../services/request-body";

const MAX_ACK_REQUEST_BYTES = 32 * 1024;

export async function handleSupervisionAck(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized", received: false }, { status: 401 });

  const parsed = await readJsonObjectRequest(req, {
    maxBytes: MAX_ACK_REQUEST_BYTES,
    tooLargeBody: { error: "Request too large", received: false },
  });
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const bodyType = body.type;
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
