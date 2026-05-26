const CDN_MODE = /^(1|true|yes)$/i.test(process.env.CDN_MODE || "");

export function isCdnMode(): boolean {
  return CDN_MODE;
}

export function withCdnHeaders(response: Response, tags: string[], maxAgeSeconds: number): Response {
  if (!CDN_MODE) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}, stale-while-revalidate=30`);
  headers.set("Cache-Tag", tags.join(","));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function currentHourWindow(date = new Date()): string {
  return date.toISOString().slice(0, 13).replace(/[-T:]/g, "");
}
