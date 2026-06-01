import { getDailySummary } from "../db";
import { withCdnHeaders } from "../services/cdn";

export function handleDailySummary(url: URL): Response {
  const date = url.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "Missing or invalid date param (YYYY-MM-DD)" }, { status: 400 });
  }

  const row = getDailySummary.get(date) as { date: string; summary: string; generated_at: string } | null;

  if (!row) {
    return withCdnHeaders(
      Response.json({ date, summary: null, generated_at: null }),
      ["daily-summary", `daily-summary-${date}`],
      60,
    );
  }

  return withCdnHeaders(
    Response.json(row),
    ["daily-summary", `daily-summary-${date}`],
    60,
  );
}
