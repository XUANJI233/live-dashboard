// Size rules for the ledger section of get_controller_context. Pure, so the envelope budget can use
// them without opening the database.

export const LEDGER_SECTION_MAX_BYTES = 3_000;
export const LEDGER_DUE_NOW_LIMIT = 8;

/** Lower-priority detail goes first; due_now is only ever clipped. True when anything was cut. */
export function fitLedgerSection(section: Record<string, unknown>, maxBytes = LEDGER_SECTION_MAX_BYTES): boolean {
  const steps = [
    () => popLast(section.closed_in_range),
    () => popLast(section.hypotheses),
    () => popLast(section.breaches),
    () => popLast(section.open),
    () => clipDueNow(section.due_now, 60, 60),
    () => clipDueNow(section.due_now, 0, 40),
  ];
  let truncated = false;
  for (const step of steps) {
    while (serializedBytes(section) > maxBytes && step()) truncated = true;
  }
  return truncated;
}

/** What survives the absolute-minimal envelope: what is due, by id and title. */
export function minimalLedger(value: unknown): Record<string, unknown> {
  const dueNow = isRecord(value) && Array.isArray(value.due_now) ? value.due_now : [];
  return {
    due_now: dueNow.filter(isRecord).slice(0, LEDGER_DUE_NOW_LIMIT).map((item) => ({
      record_id: item.record_id,
      kind: item.kind,
      title: clipLedgerText(item.title, 40),
      due_at: item.due_at,
    })),
  };
}

export function clipLedgerText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const characters = Array.from(value);
  return characters.length > maxLength ? `${characters.slice(0, maxLength - 1).join("")}…` : value;
}

function popLast(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  value.pop();
  return true;
}

// Stake goes first, then detail is clipped (0 drops it), then the title.
function clipDueNow(value: unknown, detailLength: number, titleLength: number): boolean {
  if (!Array.isArray(value)) return false;
  let changed = false;
  for (const item of value.filter(isRecord)) {
    if (item.stake !== undefined) {
      delete item.stake;
      changed = true;
    }
    if (typeof item.detail === "string") {
      const detail = detailLength > 0 ? clipLedgerText(item.detail, detailLength) : "";
      if (detail !== item.detail) changed = true;
      if (detail) item.detail = detail;
      else delete item.detail;
    }
    const title = clipLedgerText(item.title, titleLength);
    if (typeof item.title === "string" && title !== item.title) {
      item.title = title;
      changed = true;
    }
  }
  return changed;
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
