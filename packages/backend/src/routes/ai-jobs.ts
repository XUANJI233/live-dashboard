import { authenticateToken, extractBearerToken } from "../middleware/auth";
import { noStore } from "../services/cdn";
import {
  aiJobInputErrorResponse,
  getAiJob,
  submitAiJobFromClient,
} from "../services/ai-jobs";

const MAX_AI_JOB_JSON_BYTES = 128 * 1024;

export async function handleAiJobSubmit(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  try {
    const submitted = submitAiJobFromClient(
      parsed.body,
      device,
      extractBearerToken(req.headers.get("authorization")),
    );
    return noStore(Response.json(submitted, { status: 202 }), ["ai-jobs", `ai-job-${submitted.job.request_id}`]);
  } catch (e) {
    const error = aiJobInputErrorResponse(e);
    return noStore(Response.json(error.body, { status: error.status }), ["ai-jobs"]);
  }
}

export function handleAiJobQuery(req: Request, url: URL): Response {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const job = getAiJob(url.searchParams.get("request_id"));
  if (!job) {
    return noStore(Response.json({ error: "AI job not found", code: "AI_JOB_NOT_FOUND" }, { status: 404 }), ["ai-jobs"]);
  }
  return noStore(Response.json({ found: true, job }), ["ai-jobs", `ai-job-${job.request_id}`]);
}

async function readJsonObject(req: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const length = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > MAX_AI_JOB_JSON_BYTES) {
    return { ok: false, response: Response.json({ error: "Request too large" }, { status: 413 }) };
  }
  const contentType = req.headers.get("content-type") || "";
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    return { ok: false, response: Response.json({ error: "Content-Type must be application/json" }, { status: 415 }) };
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { ok: false, response: Response.json({ error: "Invalid JSON" }, { status: 400 }) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: Response.json({ error: "JSON object required" }, { status: 400 }) };
  }
  return { ok: true, body: body as Record<string, unknown> };
}
