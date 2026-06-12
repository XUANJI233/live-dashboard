/**
 * Privacy tier system for window_title handling.
 *
 * Three tiers:
 * - SHOW:    Keep window_title as display_title (video, music, game, IDE, productivity)
 * - BROWSER: Strip browser suffix, then classify (video sites → show, sensitive → hide, else show page title)
 * - HIDE:    display_title empty, window_title not stored (chat, email, banking, system, proxy)
 */

import privacyRules from "../data/privacy-rules.json";

export type PrivacyTier = "show" | "browser" | "hide";

type RuleGroups = Record<string, string[]>;
type PrivacyRuleData = {
  tiers: Record<PrivacyTier, RuleGroups>;
  browserSuffixes: string[];
  sensitiveBrowserTitleKeywords: string[];
  videoSiteKeywords: string[];
  appSuffixes: string[];
  titleProcessing: Record<"music" | "ide" | "video" | "document" | "design", string[]>;
};

const rules = privacyRules as PrivacyRuleData;
const privacyTiers: PrivacyTier[] = ["show", "browser", "hide"];

// ── App → Tier mapping ──

function buildTierMap(tiers: PrivacyRuleData["tiers"]): Map<string, PrivacyTier> {
  const map = new Map<string, PrivacyTier>();

  for (const tier of privacyTiers) {
    for (const names of Object.values(tiers[tier])) {
      for (const name of names) {
        map.set(name.toLowerCase(), tier);
      }
    }
  }

  return map;
}

function toLowerSet(values: string[]): Set<string> {
  return new Set(values.map((value) => value.toLowerCase()));
}

const tierMap = buildTierMap(rules.tiers);

// ── Public API ──

export function getPrivacyTier(appName: string): PrivacyTier {
  if (!appName) return "hide";
  // Default to "show" for unknown apps (e.g. games, galgame executables).
  // All sensitive categories (chat, email, finance, system, proxy, social)
  // are explicitly registered as "hide" above.
  return tierMap.get(appName.toLowerCase()) ?? "show";
}

// ── Browser suffix patterns (order matters — try longest first) ──

const browserSuffixes = rules.browserSuffixes;

// ── Sensitive keywords for browser titles ──
// Conservative: if ANY of these appear in the page title, hide it entirely.
// Better to over-hide than to leak private data.

const sensitiveKeywords = rules.sensitiveBrowserTitleKeywords;

// ── Video-site keywords in browser tab titles ──

const videoSiteKeywords = rules.videoSiteKeywords;

// ── Title extraction helpers ──

/** Remove zero-width characters that Windows sometimes injects (e.g. Edge: "Microsoft​ Edge" has U+200B). */
function stripZeroWidth(s: string): string {
  return s.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
}

/** Strip browser name suffix from a tab title (case-insensitive). */
function stripBrowserSuffix(title: string): string {
  const cleaned = stripZeroWidth(title);
  const lower = cleaned.toLowerCase();

  // Try Edge profile pattern first (more specific): "title - ProfileName - Microsoft Edge"
  const edgeProfileRe = /\s-\s[^-]+\s-\sMicrosoft\s*Edge$/i;
  const m = edgeProfileRe.exec(cleaned);
  if (m && m.index !== undefined) {
    return cleaned.slice(0, m.index).trim();
  }

  // Then try simple suffix matching
  for (const suffix of browserSuffixes) {
    if (lower.endsWith(suffix.toLowerCase())) {
      return cleaned.slice(0, -suffix.length).trim();
    }
  }

  return cleaned;
}

/** Check if a browser title contains sensitive keywords. */
function isSensitiveBrowserTitle(title: string): boolean {
  const lower = title.toLowerCase();
  return sensitiveKeywords.some((kw) => lower.includes(kw));
}

/** Check if a browser title is from a video site. */
function isVideoSiteTitle(title: string): boolean {
  const lower = title.toLowerCase();
  return videoSiteKeywords.some((kw) => lower.includes(kw));
}

// ── App-specific suffix patterns to strip ──

const appSuffixes = rules.appSuffixes;

/** Strip app-name suffixes from video/music titles (case-insensitive). */
function stripAppSuffix(title: string): string {
  const cleaned = stripZeroWidth(title);
  const lower = cleaned.toLowerCase();
  for (const suffix of appSuffixes) {
    if (lower.endsWith(suffix.toLowerCase())) {
      return cleaned.slice(0, -suffix.length).trim();
    }
  }
  return cleaned;
}

/**
 * Extract meaningful part from a music player title.
 * Common formats:
 * - Spotify: "Song - Artist" or "Spotify Premium" or "Spotify Free"
 * - 网易云: "Song - Artist"
 * - foobar2000: "[HH:MM:SS] Artist - Song [foobar2000]"
 */
function extractMusicTitle(appName: string, title: string): string {
  if (!title) return "";
  const lower = title.toLowerCase();

  // Skip idle/paused states
  if (lower === "spotify" || lower === "spotify premium" || lower === "spotify free") return "";
  if (lower === "网易云音乐") return "";
  if (lower === "qq音乐") return "";

  // foobar2000: strip "[HH:MM:SS] " prefix and " [foobar2000]" suffix
  if (appName.toLowerCase() === "foobar2000") {
    let cleaned = title.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, "");
    cleaned = cleaned.replace(/\s*\[foobar2000\]$/i, "");
    return cleaned.trim();
  }

  // Generic: "Song - Artist" → keep the whole thing, it's short enough
  return stripAppSuffix(title).trim();
}

/**
 * Extract project/file name from an IDE title.
 * Common formats:
 * - VS Code: "file.ts — project — Visual Studio Code" or "project — Visual Studio Code"
 * - Cursor: same as VS Code but ends with "Cursor"
 * - JetBrains: "project – file.ts" or "project"
 * - Sublime: "file.ts - project - Sublime Text"
 */
function extractIDETitle(title: string): string {
  if (!title) return "";

  // VS Code / Cursor: split by " — " (em dash), take everything except the last segment (app name)
  if (title.includes(" — ")) {
    const parts = title.split(" — ");
    if (parts.length >= 2) {
      // Last part is the editor name; take the rest
      const meaningful = parts.slice(0, -1).join(" — ");
      return meaningful.trim();
    }
  }

  // JetBrains: split by " – " (en dash)
  if (title.includes(" – ")) {
    const parts = title.split(" – ");
    // First part is typically the project name
    return (parts[0] || title).trim();
  }

  // Sublime Text: split by " - " (hyphen), last is app name
  if (title.includes(" - ")) {
    const parts = title.split(" - ");
    if (parts.length >= 2) {
      const last = (parts[parts.length - 1] || "").trim().toLowerCase();
      if (last === "sublime text") {
        return parts.slice(0, -1).join(" - ").trim();
      }
    }
  }

  return title.trim();
}

/**
 * Extract document name from productivity app title.
 * Common formats:
 * - Word/Excel/PPT: "Document.docx - Microsoft Word"
 * - OneNote: "Section - Page - OneNote"
 * - Notion: "Page Title — Notion"
 * - Obsidian: "file.md - Vault - Obsidian"
 */
function extractDocTitle(title: string): string {
  if (!title) return "";

  // Notion: split by " — "
  if (title.includes(" — ")) {
    const parts = title.split(" — ");
    if (parts.length >= 2) {
      return parts.slice(0, -1).join(" — ").trim();
    }
  }

  // Others: split by " - ", last part is app name
  if (title.includes(" - ")) {
    const parts = title.split(" - ");
    if (parts.length >= 2) {
      return parts.slice(0, -1).join(" - ").trim();
    }
  }

  return title.trim();
}

// ── App category detection for title processing ──

const musicApps = toLowerSet(rules.titleProcessing.music);
const ideApps = toLowerSet(rules.titleProcessing.ide);
const videoApps = toLowerSet(rules.titleProcessing.video);
const docApps = toLowerSet(rules.titleProcessing.document);
const designApps = toLowerSet(rules.titleProcessing.design);

// ── Main display_title processor ──

/**
 * Generate a safe display_title from app_name + window_title.
 * Returns empty string if the title should be hidden.
 */
export function processDisplayTitle(appName: string, windowTitle: string): string {
  if (!appName || !windowTitle) return "";

  const tier = getPrivacyTier(appName);
  const lowerApp = appName.toLowerCase();

  if (tier === "hide") {
    return "";
  }

  if (tier === "browser") {
    // Strip browser suffix first
    const pageTitle = stripBrowserSuffix(windowTitle);
    if (!pageTitle) return "";

    // Sensitive content → hide
    if (isSensitiveBrowserTitle(pageTitle)) return "";

    // Video site → show the video title
    if (isVideoSiteTitle(pageTitle)) {
      return stripAppSuffix(pageTitle).trim() || "";
    }

    // Other pages → show page title as-is
    return pageTitle;
  }

  // tier === "show"
  if (musicApps.has(lowerApp)) {
    return extractMusicTitle(appName, windowTitle);
  }
  if (ideApps.has(lowerApp)) {
    return extractIDETitle(windowTitle);
  }
  if (videoApps.has(lowerApp)) {
    return stripAppSuffix(windowTitle).trim();
  }
  if (docApps.has(lowerApp)) {
    return extractDocTitle(windowTitle);
  }
  if (designApps.has(lowerApp)) {
    return extractDocTitle(windowTitle);
  }

  // Games, galgame, etc. — use title directly
  return windowTitle.trim();
}
