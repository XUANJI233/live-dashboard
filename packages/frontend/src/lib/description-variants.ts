/**
 * Several playful texts for one app, and the status texts kept by upstream Monika-Dream/live-dashboard.
 * The upstream file is its `status-texts.json` "exact" map, copied as is so it can be refreshed.
 */

import upstreamTexts from "./upstream-status-texts.json";

export type DescriptionText = string | string[];

// One text holds for half an hour, then the next bucket may pick another.
const VARIANT_BUCKET_MS = 30 * 60 * 1000;

/** A stable pick per app and half hour, so a card does not flicker between renders. */
export function pickVariant(name: string, text: DescriptionText | undefined, now = Date.now()): string | undefined {
  if (!Array.isArray(text)) return text;
  if (text.length === 0) return undefined;
  let hash = Math.floor(now / VARIANT_BUCKET_MS);
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) | 0;
  return text[Math.abs(hash) % text.length];
}

/**
 * Apps described nowhere here take upstream's texts; where upstream has several texts for an app we
 * describe once, ours leads the set. A single upstream text never replaces ours.
 */
export function mergeUpstreamTexts(
  descriptions: Record<string, DescriptionText>,
  upstream: Record<string, DescriptionText> = upstreamTexts,
): void {
  const byLower = new Map(Object.keys(descriptions).map((key) => [key.toLowerCase(), key]));
  for (const [name, text] of Object.entries(upstream)) {
    const key = byLower.get(name.toLowerCase());
    if (key === undefined) {
      descriptions[name] = text;
      byLower.set(name.toLowerCase(), name);
    } else if (Array.isArray(text)) {
      const ours = descriptions[key]!;
      descriptions[key] = [...new Set([...(Array.isArray(ours) ? ours : [ours]), ...text])];
    }
  }
}
