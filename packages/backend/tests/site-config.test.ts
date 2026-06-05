import { describe, expect, test } from "bun:test";
import {
  getSiteConfig,
  injectSiteConfig,
  DISPLAY_NAME_PLACEHOLDER,
  SITE_TITLE_PLACEHOLDER,
} from "../src/services/site-config";

describe("site-config", () => {
  test("getSiteConfig returns config with defaults", () => {
    const config = getSiteConfig();
      expect(typeof config.displayName).toBe("string");
    expect(typeof config.displayName).toBe("string");
    expect(typeof config.siteDescription).toBe("string");
  });

  test("injectSiteConfig replaces placeholders", () => {
    const html = `<title>${SITE_TITLE_PLACEHOLDER}</title>`;
    const result = injectSiteConfig(html);
    expect(result).not.toContain(SITE_TITLE_PLACEHOLDER);
  });

  test("injectSiteConfig keeps plain HTML intact", () => {
    const html = "<title>Hello</title>";
    const result = injectSiteConfig(html);
    expect(result).toContain("Hello");
  });
});
