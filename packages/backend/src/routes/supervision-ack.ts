import { authenticateToken } from "../middleware/auth";
import { receiveSupervisionAck } from "../services/supervision-ack";

const MAX_ACK_REQUEST_BYTES = 4096;

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

  const receipt = receiveSupervisionAck(body, device);
  return Response.json(
    receipt.received
      ? { received: true, ack_id: receipt.ack_id }
      : { received: false, ack_id: receipt.ack_id, error: receipt.error ?? "invalid_ack" },
    { status: receipt.received ? 200 : 400 },
  );
}
