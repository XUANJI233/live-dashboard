import { withCdnHeaders } from "../services/cdn";

export function handleHealth(): Response {
  return withCdnHeaders(
    Response.json({
      status: "ok",
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    }),
    ["health"],
    5,
  );
}
