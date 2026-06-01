const CDN_MODE = /^(1|true|yes)$/i.test(process.env.CDN_MODE || "");

export function isCdnMode(): boolean {
  return CDN_MODE;
}

export function withCdnHeaders(response: Response, tags: string[], maxAgeSeconds: number): Response {
  const headers = new Headers(response.headers);
  if (tags.length > 0) {
    const joined = tags.join(",");
    headers.set("Cache-Tag", joined);
    headers.set("ESA-Cache-Tag", joined);
  }
  // Browser cache always applies
  headers.set("Cache-Control", `public, max-age=${maxAgeSeconds}, stale-while-revalidate=30`);
  // CDN-specific headers only in CDN mode
  if (CDN_MODE) {
    headers.set("Cache-Control", `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}, stale-while-revalidate=30`);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  // Aggressive anti-cache headers — Alibaba Cloud ESA ignores bare "no-store"
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0, s-maxage=0");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Surrogate-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function currentHourWindow(date = new Date()): string {
  return date.toISOString().slice(0, 13).replace(/[-T:]/g, "");
}

export function currentMessageSlot(date = new Date(), slotMinutes = 10): string {
  const safeSlot = Math.max(1, Math.min(60, Math.floor(slotMinutes)));
  const roundedMinute = Math.floor(date.getUTCMinutes() / safeSlot) * safeSlot;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(roundedMinute).padStart(2, "0");
  return `${year}${month}${day}${hour}${minute}`;
}
