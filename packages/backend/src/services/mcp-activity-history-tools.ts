import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getActivityHistory } from "./activity-history";
import { ActivityHistorySchema } from "./mcp-tool-schemas";
import { stableToolResult } from "./mcp-tool-result";

// The one history reader: complete server-side totals and paged session lists, MCP-only.
export function registerActivityHistoryTools(server: McpServer): void {
  server.registerTool("live_dashboard.get_activity_history", {
    title: "Get activity history",
    description: "Stored phone/PC activity (7-day retention), summed on the server. view=usage: minutes per app, title, local day or hour, with sessions, first/last session start, and per-device idle and unobserved minutes. view=timeline: chronological app sessions with titles and background media, paged by cursor. Filters: device_id, app, package, title_contains. Times are local to timezone_offset_minutes (default: saved summary timezone, else UTC+08:00); start/end without an offset are local. Idle and sleeping never count as usage. totals and devices are always complete; only groups and sessions page. Errors: invalid_time, invalid_time_range, time_range_too_large, device_not_found, invalid_cursor, history_scan_too_large.",
    inputSchema: ActivityHistorySchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => stableToolResult(() => getActivityHistory(args)));
}
