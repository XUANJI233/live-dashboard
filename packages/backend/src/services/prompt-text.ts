// Plain-text cleanup shared by supervision prompts and rule matching: control
// characters and angle brackets are replaced so text cannot forge prompt tags.
export function promptText(value: string | null | undefined, maxLength: number): string {
  if (!value) return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[<>]/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 12)
    .join("\n")
    .trim()
    .slice(0, maxLength);
}
