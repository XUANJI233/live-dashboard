import { db } from "../db";
import { clippedText } from "./clipped-text";
import { safeJsonParseObject } from "./mcp-contracts";

// What was actually done to the devices in a daily or weekly range: reminders, vibrations,
// screen-offs, freezes and unfreezes from the controller or Live supervision, and Live's own
// commitment enforcement, labelled rule_enforcement. Totals cover the whole range in SQL; the
// command list keeps the newest commands of each kind and the context budget trims it further.

const MAX_LISTED_COMMANDS = 24;
const MAX_LISTED_RULE_COMMANDS = 12;
const MAX_LISTED_PATTERNS = 4;
const MAX_LISTED_NOTES = 3;
const MAX_SAY_LENGTH = 80;
const MAX_PATTERN_LENGTH = 60;

const PAYLOAD_SQL = "(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END)";
const RULE_ENFORCEMENT_SQL = `(created_by = 'supervision'
  AND (request_id LIKE 'commitment-sync-%' OR request_id LIKE 'commitment-exception-%'))`;
// One-shot supervision commands in the range that carried an action or a note on a dropped one.
const RANGE_SQL = `kind = 'supervision' AND issued_at >= ? AND issued_at < ?
  AND (COALESCE(json_extract(${PAYLOAD_SQL}, '$.payload.say'), '') <> ''
    OR json_extract(${PAYLOAD_SQL}, '$.payload.vibrate') = 1
    OR json_extract(${PAYLOAD_SQL}, '$.payload.screen_off') = 1
    OR COALESCE(json_array_length(${PAYLOAD_SQL}, '$.payload.freeze_commands'), 0) > 0
    OR COALESCE(json_array_length(${PAYLOAD_SQL}, '$.payload.unfreeze_commands'), 0) > 0
    OR COALESCE(json_array_length(${PAYLOAD_SQL}, '$.payload.notes'), 0) > 0)`;

const totalsStmt = db.prepare(`
  SELECT
    CASE WHEN ${RULE_ENFORCEMENT_SQL} THEN 'rule_enforcement'
         WHEN created_by = 'supervision' THEN 'supervision'
         ELSE 'controller' END AS source,
    COUNT(*) AS commands,
    TOTAL(COALESCE(json_extract(${PAYLOAD_SQL}, '$.payload.say'), '') <> '') AS say,
    TOTAL(json_extract(${PAYLOAD_SQL}, '$.payload.vibrate') = 1) AS vibrate,
    TOTAL(json_extract(${PAYLOAD_SQL}, '$.payload.screen_off') = 1) AS screen_off,
    TOTAL(COALESCE(json_array_length(${PAYLOAD_SQL}, '$.payload.freeze_commands'), 0) > 0) AS freeze,
    TOTAL(COALESCE(json_array_length(${PAYLOAD_SQL}, '$.payload.unfreeze_commands'), 0) > 0) AS unfreeze,
    TOTAL(result_status IN ('applied', 'partial')) AS applied
  FROM device_commands
  WHERE ${RANGE_SQL}
  GROUP BY source
`);

const commandsStmt = (rule: boolean) => db.prepare(`
  SELECT request_id, target_device_id, created_by, payload, issued_at, expires_at,
         delivery_status, result_status
  FROM device_commands
  WHERE ${RANGE_SQL} AND ${rule ? "" : "NOT "}${RULE_ENFORCEMENT_SQL}
  ORDER BY issued_at DESC, command_id DESC
  LIMIT ?
`);
const otherCommandsStmt = commandsStmt(false);
const ruleCommandsStmt = commandsStmt(true);

interface CommandRow {
  request_id: string;
  target_device_id: string;
  created_by: string;
  payload: string;
  issued_at: string;
  expires_at: string;
  delivery_status: string;
  result_status: string;
}

export function loadEnforcementDigest(range: { start: string; end: string }, now = new Date()): Record<string, unknown> {
  const totals: Record<string, Record<string, number>> = {};
  let commandCount = 0;
  for (const row of totalsStmt.all(range.start, range.end) as Array<Record<string, unknown>>) {
    const { source, ...counts } = row;
    totals[String(source)] = Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value) || 0]));
    commandCount += Number(row.commands) || 0;
  }
  const rows = [
    ...otherCommandsStmt.all(range.start, range.end, MAX_LISTED_COMMANDS) as CommandRow[],
    ...ruleCommandsStmt.all(range.start, range.end, MAX_LISTED_RULE_COMMANDS) as CommandRow[],
  ].sort((left, right) => left.issued_at.localeCompare(right.issued_at));
  const commands = rows.map((row) => compactCommand(row, now));
  return {
    range,
    totals,
    command_count: commandCount,
    returned_count: commands.length,
    truncated: commands.length < commandCount,
    commands,
  };
}

function compactCommand(row: CommandRow, now: Date): Record<string, unknown> {
  // The ledger stores the whole envelope; the actions sit in its payload.
  const payload = safeJsonParseObject(row.payload).payload;
  const action = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const rule = row.created_by === "supervision" ? /^commitment-(sync|exception)-/i.exec(row.request_id) : null;
  const item: Record<string, unknown> = {
    at: row.issued_at,
    device_id: row.target_device_id,
    source: rule ? "rule_enforcement" : row.created_by === "supervision" ? "supervision" : "controller",
  };
  // A time-boxed exception Live opened on request; the matching re-freeze is a plain sync.
  if (rule?.[1]?.toLowerCase() === "exception") item.exception = true;
  if (typeof action.say === "string" && action.say) item.say = clippedText(action.say, MAX_SAY_LENGTH);
  if (action.vibrate === true) item.vibrate = true;
  if (action.screen_off === true) item.screen_off = true;
  const freeze = listedPatterns(action.freeze_commands);
  if (freeze.length > 0) item.freeze = freeze;
  const unfreeze = listedPatterns(action.unfreeze_commands);
  if (unfreeze.length > 0) item.unfreeze = unfreeze;
  const notes = Array.isArray(action.notes) ? action.notes.filter((note) => typeof note === "string").slice(0, MAX_LISTED_NOTES) : [];
  if (notes.length > 0) item.notes = notes;
  item.result = commandResult(row, now);
  return item;
}

/** Exact anchored package patterns read as package names. */
function listedPatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((pattern): pattern is string => typeof pattern === "string").slice(0, MAX_LISTED_PATTERNS).map((pattern) => {
    const exact = /^\^((?:[A-Za-z0-9_]|\\\.)+)\$$/.exec(pattern);
    return exact ? exact[1]!.replace(/\\\./g, ".") : clippedText(pattern, MAX_PATTERN_LENGTH);
  });
}

function commandResult(row: CommandRow, now: Date): string {
  if (row.delivery_status === "skipped" || row.delivery_status === "failed") return row.delivery_status;
  if (row.result_status !== "unknown") return row.result_status;
  return Date.parse(row.expires_at) < now.getTime() ? "timeout" : "pending";
}
