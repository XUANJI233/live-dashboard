export type LimitedTextRead =
  | { ok: true; text: string }
  | { ok: false; response: Response };

export type JsonObjectRead =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response };

export async function readLimitedRequestText(
  req: Request,
  maxBytes: number,
  tooLargeBody: Record<string, unknown> = { error: "Request too large" },
): Promise<LimitedTextRead> {
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false, response: Response.json(tooLargeBody, { status: 413 }) };
  }
  if (!req.body) return { ok: true, text: "" };

  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, response: Response.json(tooLargeBody, { status: 413 }) };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return { ok: false, response: Response.json(tooLargeBody, { status: 413 }) };
  }
  return { ok: true, text };
}

export async function readJsonObjectRequest(
  req: Request,
  options: {
    maxBytes: number;
    requireJsonContentType?: boolean;
    emptyObjectOnInvalid?: boolean;
    tooLargeBody?: Record<string, unknown>;
  },
): Promise<JsonObjectRead> {
  if (options.requireJsonContentType) {
    const contentType = req.headers.get("content-type") || "";
    if (contentType && !contentType.toLowerCase().includes("application/json")) {
      return {
        ok: false,
        response: Response.json({ error: "Content-Type must be application/json" }, { status: 415 }),
      };
    }
  }

  const raw = await readLimitedRequestText(req, options.maxBytes, options.tooLargeBody);
  if (!raw.ok) return raw;
  try {
    const parsed = raw.text ? JSON.parse(raw.text) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return options.emptyObjectOnInvalid
        ? { ok: true, body: {} }
        : { ok: false, response: Response.json({ error: "JSON object required" }, { status: 400 }) };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return options.emptyObjectOnInvalid
      ? { ok: true, body: {} }
      : { ok: false, response: Response.json({ error: "Invalid JSON" }, { status: 400 }) };
  }
}
