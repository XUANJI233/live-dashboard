import appNamesData from "../data/app-names.json";

// Build case-insensitive lookup maps
const windowsMap = new Map<string, string>();
for (const [key, value] of Object.entries(appNamesData.windows)) {
  windowsMap.set(key.toLowerCase(), value);
}

const androidMap = new Map<string, string>();
for (const [key, value] of Object.entries(appNamesData.android)) {
  androidMap.set(key.toLowerCase(), value);
}

const macosMap = new Map<string, string>();
for (const [key, value] of Object.entries(appNamesData.macos)) {
  macosMap.set(key.toLowerCase(), value);
}

// Host processes (from upstream 9320cf5, issue #43): every Java desktop app runs as javaw.exe, so
// its window title names the real app. Specific signatures first; Minecraft first of those, since
// official and launcher titles all contain the word.
const HOST_PROCESS_IDS = new Set(["javaw.exe", "java.exe", "javaw", "java"]);
const HOST_TITLE_SIGNATURES: Array<[RegExp, string]> = [
  [/minecraft/i, "Minecraft"],
  [/jquake/i, "JQuake"],
  [/ghidra/i, "Ghidra"],
  [/jadx/i, "jadx"],
  [/jdownloader/i, "JDownloader"],
  [/burp suite/i, "Burp Suite"],
  [/runelite/i, "RuneLite"],
  [/dbeaver/i, "DBeaver"],
  [/jmeter/i, "JMeter"],
  [/visualvm/i, "VisualVM"],
  [/arduino/i, "Arduino IDE"],
  [/jd-gui/i, "JD-GUI"],
];

/** The real app behind a host process, read from its window title; undefined for other processes. */
export function resolveHostAppName(appId: string, windowTitle?: string): string | undefined {
  if (!appId || !HOST_PROCESS_IDS.has(appId.toLowerCase())) return undefined;
  const title = (windowTitle ?? "").trim();
  if (!title) return "Java 应用";
  for (const [pattern, name] of HOST_TITLE_SIGNATURES) {
    if (pattern.test(title)) return name;
  }
  return appNameFromTitle(title) ?? "Java 应用";
}

// Windows titles read "document - App"; the app is the last part, a single part is the app itself.
// Taking only the last part keeps document and page names out of the stored app name.
function appNameFromTitle(title: string): string | undefined {
  const parts = title.split(/\s+[-—–|·]\s+/);
  const last = (parts[parts.length - 1] ?? "").trim().replace(/\s+v?\d+(\.\d+)+\s*$/i, "").trim();
  return last && last.length <= 48 ? last.replace(/[\u0000-\u001f\u007f]/g, "") : undefined;
}

export function resolveAppName(
  appId: string,
  platform: "windows" | "android" | "macos" | "zepp"
): string {
  if (!appId || typeof appId !== "string") return "Unknown";
  const lower = appId.toLowerCase();

  if (platform === "windows") {
    const found = windowsMap.get(lower);
    if (found) return found;
    if (lower.endsWith(".exe")) return appId.replace(/\.exe$/i, "");
    return appId;
  }

  if (platform === "android") {
    const found = androidMap.get(lower);
    if (found) return found;
    if (appId.includes(".")) {
      const parts = appId.split(".");
      const last = parts[parts.length - 1] || appId;
      return last.charAt(0).toUpperCase() + last.slice(1);
    }
    return appId;
  }

  if (platform === "zepp") {
    if (lower === "zepp_watch") return "Zepp Watch";
    return appId;
  }

  // macos: System Events already returns human-readable names (e.g. "Google Chrome").
  // Only a few process names need remapping (e.g. "Code" → "Visual Studio Code").
  const found = macosMap.get(lower);
  return found ?? appId;
}
