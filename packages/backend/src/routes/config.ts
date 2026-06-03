import { getSiteConfig } from "../services/site-config";
import { withCdnHeaders } from "../services/cdn";

export function handleConfig(): Response {
  return withCdnHeaders(Response.json(getSiteConfig()), ["config"], 60);
}
