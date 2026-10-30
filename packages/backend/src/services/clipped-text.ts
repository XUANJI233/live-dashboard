/** Clip to at most `maxLength` code points, ending in "…" when shortened; never splits a surrogate pair. */
export function clippedText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  let codePoints = 0;
  let bodyEnd = 0;
  for (const character of value) {
    if (codePoints === maxLength) return `${value.slice(0, bodyEnd)}…`;
    codePoints += 1;
    if (codePoints < maxLength) bodyEnd += character.length;
  }
  return value;
}
