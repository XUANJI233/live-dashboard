// @bun
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// packages/backend/src/db.ts
var exports_db = {};
__export(exports_db, {
  upsertDeviceState: () => upsertDeviceState,
  upsertDailySummary: () => upsertDailySummary,
  optimizeDatabase: () => optimizeDatabase,
  markOfflineDevices: () => markOfflineDevices,
  insertLocationRecord: () => insertLocationRecord,
  insertActivity: () => insertActivity,
  hmacTitle: () => hmacTitle,
  getRecentActivities: () => getRecentActivities,
  getDailySummary: () => getDailySummary,
  getAllDeviceStates: () => getAllDeviceStates,
  deleteDeviceActivities: () => deleteDeviceActivities,
  deleteDevice: () => deleteDevice,
  default: () => db_default,
  db: () => db,
  cleanupOldSummaries: () => cleanupOldSummaries,
  cleanupOldLocations: () => cleanupOldLocations,
  cleanupOldActivities: () => cleanupOldActivities,
  cleanupExpiredMessages: () => cleanupExpiredMessages
});
import { Database } from "bun:sqlite";
function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw)
    return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function optimizeDatabase(startup = false) {
  db.run(startup ? "PRAGMA optimize=0x10002" : "PRAGMA optimize");
}
function columnExists(table, column) {
  if (!KNOWN_TABLES.has(table)) {
    throw new Error(`columnExists: unknown table "${table}"`);
  }
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}
function hmacTitle(title) {
  const hmac = new Bun.CryptoHasher("sha256", HASH_SECRET);
  hmac.update(title);
  return hmac.digest("hex");
}
var DB_PATH, SQLITE_BUSY_TIMEOUT_MS, SQLITE_WAL_AUTOCHECKPOINT_PAGES, SQLITE_CACHE_SIZE_KIB, SQLITE_MMAP_SIZE_BYTES, SQLITE_JOURNAL_SIZE_LIMIT_BYTES, db, journalMode, KNOWN_TABLES, deviceMessageColumns, oldDeviceMessagePk, HASH_SECRET, insertActivity, upsertDeviceState, getAllDeviceStates, getRecentActivities, markOfflineDevices, cleanupOldActivities, cleanupExpiredMessages, insertLocationRecord, cleanupOldLocations, upsertDailySummary, getDailySummary, cleanupOldSummaries, deleteDevice, deleteDeviceActivities, db_default;
var init_db = __esm(() => {
  DB_PATH = process.env.DB_PATH || "./live-dashboard.db";
  SQLITE_BUSY_TIMEOUT_MS = positiveIntegerEnv("SQLITE_BUSY_TIMEOUT_MS", 5000);
  SQLITE_WAL_AUTOCHECKPOINT_PAGES = positiveIntegerEnv("SQLITE_WAL_AUTOCHECKPOINT_PAGES", 1000);
  SQLITE_CACHE_SIZE_KIB = positiveIntegerEnv("SQLITE_CACHE_SIZE_KIB", 32 * 1024);
  SQLITE_MMAP_SIZE_BYTES = positiveIntegerEnv("SQLITE_MMAP_SIZE_BYTES", 256 * 1024 * 1024);
  SQLITE_JOURNAL_SIZE_LIMIT_BYTES = positiveIntegerEnv("SQLITE_JOURNAL_SIZE_LIMIT_BYTES", 64 * 1024 * 1024);
  db = new Database(DB_PATH, { create: true });
  db.run("PRAGMA foreign_keys = ON");
  db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  journalMode = db.query("PRAGMA journal_mode = WAL").get();
  if (journalMode?.journal_mode?.toLowerCase() !== "wal") {
    console.warn(`[db] SQLite WAL mode was not enabled, current journal_mode=${journalMode?.journal_mode ?? "unknown"}`);
  }
  db.run("PRAGMA synchronous = NORMAL");
  db.run(`PRAGMA wal_autocheckpoint = ${SQLITE_WAL_AUTOCHECKPOINT_PAGES}`);
  db.run(`PRAGMA cache_size = -${SQLITE_CACHE_SIZE_KIB}`);
  db.run(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
  db.run(`PRAGMA journal_size_limit = ${SQLITE_JOURNAL_SIZE_LIMIT_BYTES}`);
  db.run("PRAGMA temp_store = MEMORY");
  db.run(`
  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    device_name TEXT NOT NULL,
    platform TEXT NOT NULL,
    app_id TEXT NOT NULL,
    app_name TEXT NOT NULL,
    window_title TEXT DEFAULT '',
    title_hash TEXT NOT NULL DEFAULT '',
    time_bucket INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);
  db.run(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_dedup
  ON activities(device_id, app_id, title_hash, time_bucket)
`);
  db.run(`
  CREATE INDEX IF NOT EXISTS idx_activities_device_started
  ON activities(device_id, started_at DESC)
`);
  db.run(`
  CREATE INDEX IF NOT EXISTS idx_activities_started
  ON activities(started_at DESC)
`);
  db.run(`
  CREATE INDEX IF NOT EXISTS idx_activities_created
  ON activities(created_at)
`);
  db.run(`
  CREATE TABLE IF NOT EXISTS device_states (
    device_id TEXT PRIMARY KEY,
    device_name TEXT NOT NULL,
    platform TEXT NOT NULL,
    app_id TEXT NOT NULL,
    app_name TEXT NOT NULL,
    window_title TEXT DEFAULT '',
    last_seen_at TEXT NOT NULL,
    is_online INTEGER DEFAULT 1
  )
`);
  KNOWN_TABLES = new Set(["activities", "device_states"]);
  if (!columnExists("activities", "display_title")) {
    db.run("ALTER TABLE activities ADD COLUMN display_title TEXT DEFAULT ''");
  }
  if (!columnExists("device_states", "display_title")) {
    db.run("ALTER TABLE device_states ADD COLUMN display_title TEXT DEFAULT ''");
  }
  if (!columnExists("device_states", "extra")) {
    db.run("ALTER TABLE device_states ADD COLUMN extra TEXT DEFAULT '{}'");
  }
  db.run(`
  CREATE TABLE IF NOT EXISTS health_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    type TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    end_time TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(device_id, type, recorded_at, end_time)
  )
`);
  db.run(`
  CREATE INDEX IF NOT EXISTS idx_health_records_recorded
  ON health_records(recorded_at)
`);
  db.run(`
  CREATE INDEX IF NOT EXISTS idx_health_records_type
  ON health_records(type, recorded_at)
`);
  db.run(`
  CREATE INDEX IF NOT EXISTS idx_health_records_device_recorded
  ON health_records(device_id, recorded_at)
`);
  db.run(`
  CREATE TABLE IF NOT EXISTS location_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    accuracy_m REAL DEFAULT NULL,
    provider TEXT DEFAULT '',
    recorded_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
  db.run(`
  CREATE INDEX IF NOT EXISTS idx_location_records_device_recorded
  ON location_records(device_id, recorded_at)
`);
  db.run(`
  CREATE INDEX IF NOT EXISTS idx_location_records_recorded
  ON location_records(recorded_at)
`);
  db.run(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_location_records_dedup
  ON location_records(device_id, recorded_at)
`);
  db.run(`
  CREATE TABLE IF NOT EXISTS device_messages (
    id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    viewer_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    delivered_at TEXT DEFAULT '',
    replied_at TEXT DEFAULT '',
    PRIMARY KEY(id, device_id)
  )
`);
  deviceMessageColumns = db.prepare("PRAGMA table_info(device_messages)").all();
  oldDeviceMessagePk = deviceMessageColumns.some((column) => column.name === "id" && column.pk === 1) && !deviceMessageColumns.some((column) => column.name === "device_id" && column.pk > 0);
  if (oldDeviceMessagePk) {
    db.transaction(() => {
      db.run("ALTER TABLE device_messages RENAME TO device_messages_old");
      db.run(`
      CREATE TABLE device_messages (
        id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        viewer_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        delivered_at TEXT DEFAULT '',
        replied_at TEXT DEFAULT '',
        PRIMARY KEY(id, device_id)
      )
    `);
      db.run(`
      INSERT OR IGNORE INTO device_messages (id, device_id, viewer_id, text, created_at, expires_at, delivered_at, replied_at)
      SELECT id, device_id, viewer_id, text, created_at, expires_at, delivered_at, replied_at
      FROM device_messages_old
    `);
      db.run("DROP TABLE device_messages_old");
    })();
  }
  db.run(`
  CREATE INDEX IF NOT EXISTS idx_device_messages_pending
  ON device_messages(device_id, delivered_at, expires_at)
`);
  db.run(`
  CREATE TABLE IF NOT EXISTS conversation_messages (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    viewer_id TEXT NOT NULL,
    viewer_name TEXT DEFAULT '',
    direction TEXT NOT NULL,
    visibility TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
  db.run(`
  CREATE INDEX IF NOT EXISTS idx_conversation_messages_device_created
  ON conversation_messages(device_id, created_at)
`);
  db.run(`
  CREATE INDEX IF NOT EXISTS idx_conversation_messages_visibility_created
  ON conversation_messages(visibility, created_at)
`);
  db.run(`
  CREATE TABLE IF NOT EXISTS blocked_viewers (
    device_id TEXT NOT NULL,
    viewer_id TEXT NOT NULL,
    blocked_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(device_id, viewer_id)
  )
`);
  db.run(`
  CREATE TABLE IF NOT EXISTS viewer_remarks (
    device_id TEXT NOT NULL,
    viewer_id TEXT NOT NULL,
    remark TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(device_id, viewer_id)
  )
`);
  db.run(`
  CREATE TABLE IF NOT EXISTS visitor_messages (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    viewer_id TEXT NOT NULL,
    viewer_name TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    direction TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
  db.run(`
  CREATE INDEX IF NOT EXISTS idx_visitor_messages_device_created
  ON visitor_messages(device_id, created_at)
`);
  db.run(`
  CREATE INDEX IF NOT EXISTS idx_visitor_messages_public_created
  ON visitor_messages(kind, created_at)
`);
  db.run(`
  CREATE TABLE IF NOT EXISTS daily_summaries (
    date TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    generated_at TEXT DEFAULT (datetime('now'))
  )
`);
  optimizeDatabase(true);
  HASH_SECRET = process.env.HASH_SECRET || "";
  if (!HASH_SECRET) {
    console.error("[\u542F\u52A8\u5931\u8D25] HASH_SECRET \u672A\u8BBE\u7F6E");
    console.error("[\u542F\u52A8\u5931\u8D25] \u8FD9\u662F\u5FC5\u8981\u7684\u5B89\u5168\u5BC6\u94A5\uFF0C\u8BF7\u5728 .env \u4E2D\u914D\u7F6E");
    console.error("[\u542F\u52A8\u5931\u8D25] \u751F\u6210\u65B9\u5F0F: openssl rand -hex 32");
    process.exit(1);
  }
  if (!/^[0-9a-f]{32,128}$/i.test(HASH_SECRET)) {
    console.error(`[\u542F\u52A8\u5931\u8D25] HASH_SECRET \u683C\u5F0F\u65E0\u6548: "${HASH_SECRET.slice(0, 8)}..."`);
    console.error("[\u542F\u52A8\u5931\u8D25] \u8981\u6C42: 32-128 \u4F4D\u5341\u516D\u8FDB\u5236\u5B57\u7B26\u4E32 (0-9, a-f)");
    console.error("[\u542F\u52A8\u5931\u8D25] \u751F\u6210\u65B9\u5F0F: openssl rand -hex 32");
    process.exit(1);
  }
  insertActivity = db.prepare(`
  INSERT INTO activities (device_id, device_name, platform, app_id, app_name, window_title, display_title, title_hash, time_bucket, started_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(device_id, app_id, title_hash, time_bucket) DO NOTHING
`);
  upsertDeviceState = db.prepare(`
  INSERT INTO device_states (device_id, device_name, platform, app_id, app_name, window_title, display_title, last_seen_at, extra, is_online)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT(device_id) DO UPDATE SET
    device_name = excluded.device_name,
    platform = excluded.platform,
    app_id = excluded.app_id,
    app_name = excluded.app_name,
    window_title = excluded.window_title,
    display_title = excluded.display_title,
    last_seen_at = excluded.last_seen_at,
    extra = excluded.extra,
    is_online = 1
`);
  getAllDeviceStates = db.prepare(`
  SELECT * FROM device_states ORDER BY last_seen_at DESC
`);
  getRecentActivities = db.prepare(`
  SELECT * FROM activities ORDER BY started_at DESC LIMIT 20
`);
  markOfflineDevices = db.prepare(`
  UPDATE device_states SET is_online = 0
  WHERE is_online = 1
  AND (last_seen_at IS NULL OR last_seen_at = '' OR datetime(last_seen_at) IS NULL
       OR (
         platform = 'zepp'
         AND datetime(last_seen_at) < datetime('now', '-20 minutes')
       )
       OR (
         platform <> 'zepp'
         AND datetime(last_seen_at) < datetime('now', '-1 minute')
       ))
`);
  cleanupOldActivities = db.prepare(`
  DELETE FROM activities WHERE created_at < datetime('now', '-7 days')
`);
  cleanupExpiredMessages = db.prepare(`
  DELETE FROM device_messages WHERE datetime(expires_at) < datetime('now')
`);
  insertLocationRecord = db.prepare(`
  INSERT INTO location_records (device_id, latitude, longitude, accuracy_m, provider, recorded_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(device_id, recorded_at) DO NOTHING
`);
  cleanupOldLocations = db.prepare(`
  DELETE FROM location_records WHERE created_at < datetime('now', '-30 days')
`);
  upsertDailySummary = db.prepare(`
  INSERT INTO daily_summaries (date, summary, generated_at)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(date) DO UPDATE SET
    summary = excluded.summary,
    generated_at = datetime('now')
`);
  getDailySummary = db.prepare(`
  SELECT * FROM daily_summaries WHERE date = ?
`);
  cleanupOldSummaries = db.prepare(`
  DELETE FROM daily_summaries WHERE date < date('now', '-7 days')
`);
  deleteDevice = db.prepare(`
  DELETE FROM device_states WHERE device_id = ?
`);
  deleteDeviceActivities = db.prepare(`
  DELETE FROM activities WHERE device_id = ?
`);
  db_default = db;
});

// packages/backend/src/index.ts
import { resolve, normalize, relative, sep } from "path";
import { realpathSync } from "fs";
import { realpath as realpathAsync } from "fs/promises";

// packages/backend/src/middleware/auth.ts
var tokenMap = new Map;
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith("DEVICE_TOKEN_") && value) {
    const parts = value.split(":");
    if (parts.length >= 4) {
      const [token, device_id, device_name, platform] = [
        parts[0],
        parts[1],
        parts.slice(2, -1).join(":"),
        parts[parts.length - 1]
      ];
      if (token && device_id && device_name && (platform === "windows" || platform === "android" || platform === "macos" || platform === "zepp")) {
        tokenMap.set(token, { device_id, device_name, platform });
      } else {
        const validPlatforms = "windows / android / macos / zepp";
        if (!platform || !["windows", "android", "macos", "zepp"].includes(platform)) {
          console.warn(`[auth] ${key}: \u5E73\u53F0 "${platform}" \u65E0\u6548\uFF0C\u5FC5\u987B\u662F ${validPlatforms}`);
        } else {
          console.warn(`[auth] ${key}: \u683C\u5F0F\u4E0D\u5B8C\u6574\uFF0C\u7F3A\u5C11\u5FC5\u8981\u5B57\u6BB5`);
        }
      }
    } else if (value) {
      console.warn(`[auth] ${key}: \u683C\u5F0F\u9519\u8BEF\uFF0C\u9700\u8981 4 \u4E2A\u90E8\u5206\u7528 : \u5206\u9694`);
      console.warn(`[auth] \u6B63\u786E\u683C\u5F0F: \u5BC6\u94A5:\u8BBE\u5907ID:\u663E\u793A\u540D:\u5E73\u53F0`);
      console.warn(`[auth] \u793A\u4F8B: openssl rand -hex 16 | xargs -I{} echo "{}:my-pc:\u6211\u7684\u7535\u8111:windows"`);
    }
  }
}
if (tokenMap.size === 0) {
  console.warn("[auth] \u672A\u914D\u7F6E\u8BBE\u5907\u4EE4\u724C\uFF0C\u8BF7\u8BBE\u7F6E DEVICE_TOKEN_1 \u7B49\u73AF\u5883\u53D8\u91CF");
  console.warn("[auth] \u683C\u5F0F: \u5BC6\u94A5:\u8BBE\u5907ID:\u663E\u793A\u540D:\u5E73\u53F0 (\u5E73\u53F0: windows/android/macos/zepp)");
}
console.log(`[auth] \u5DF2\u52A0\u8F7D ${tokenMap.size} \u4E2A\u8BBE\u5907\u4EE4\u724C`);
function authenticateToken(authHeader) {
  if (!authHeader)
    return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match)
    return null;
  return tokenMap.get(match[1]) || null;
}
// packages/backend/src/data/app-names.json
var app_names_default = {
  windows: {
    "chrome.exe": "Chrome",
    "msedge.exe": "Microsoft Edge",
    "firefox.exe": "Firefox",
    "brave.exe": "Brave",
    "vivaldi.exe": "Vivaldi",
    "opera.exe": "Opera",
    "Code.exe": "VS Code",
    "explorer.exe": "\u6587\u4EF6\u8D44\u6E90\u7BA1\u7406\u5668",
    "Spotify.exe": "Spotify",
    "Discord.exe": "Discord",
    "WeChat.exe": "\u5FAE\u4FE1",
    "Telegram.exe": "Telegram",
    "WindowsTerminal.exe": "\u7EC8\u7AEF",
    "cmd.exe": "\u547D\u4EE4\u63D0\u793A\u7B26",
    "powershell.exe": "PowerShell",
    "steamwebhelper.exe": "Steam",
    "steam.exe": "Steam",
    "idea64.exe": "IntelliJ IDEA",
    "WINWORD.EXE": "Word",
    "EXCEL.EXE": "Excel",
    "POWERPNT.EXE": "PowerPoint",
    "ONENOTE.EXE": "OneNote",
    "Notion.exe": "Notion",
    "Obsidian.exe": "Obsidian",
    "mihomo-party.exe": "Mihomo Party",
    "Clash.exe": "Clash",
    "QQ.exe": "QQ",
    "Tim.exe": "TIM",
    "QQMusic.exe": "QQ\u97F3\u4E50",
    "qqmusic.exe": "QQ\u97F3\u4E50",
    "KwMusic.exe": "\u9177\u6211\u97F3\u4E50",
    "kwmusic.exe": "\u9177\u6211\u97F3\u4E50",
    "KuGou.exe": "\u9177\u72D7\u97F3\u4E50",
    "kugou.exe": "\u9177\u72D7\u97F3\u4E50",
    "cloudmusic.exe": "\u7F51\u6613\u4E91\u97F3\u4E50",
    "potplayer.exe": "PotPlayer",
    "PotPlayerMini64.exe": "PotPlayer",
    "vlc.exe": "VLC",
    "Typora.exe": "Typora",
    "notepad.exe": "\u8BB0\u4E8B\u672C",
    "mspaint.exe": "\u753B\u56FE",
    "Taskmgr.exe": "\u4EFB\u52A1\u7BA1\u7406\u5668",
    "SystemSettings.exe": "\u7CFB\u7EDF\u8BBE\u7F6E",
    "ApplicationFrameHost.exe": "UWP \u5E94\u7528",
    "SearchHost.exe": "\u641C\u7D22",
    "ShellExperienceHost.exe": "\u7CFB\u7EDF Shell",
    "TextInputHost.exe": "\u8F93\u5165\u6CD5",
    "devenv.exe": "Visual Studio",
    "rider64.exe": "JetBrains Rider",
    "pycharm64.exe": "PyCharm",
    "webstorm64.exe": "WebStorm",
    "goland64.exe": "GoLand",
    "datagrip64.exe": "DataGrip",
    "Antigravity.exe": "Google Antigravity",
    "antigravity.exe": "Google Antigravity",
    "Windsurf.exe": "Windsurf",
    "windsurf.exe": "Windsurf",
    "Zed.exe": "Zed",
    "zed.exe": "Zed",
    "Docker Desktop.exe": "Docker Desktop",
    "com.docker.backend.exe": "Docker Desktop",
    "GitHubDesktop.exe": "GitHub Desktop",
    "Postman.exe": "Postman",
    "dbeaver.exe": "DBeaver",
    "navicat.exe": "Navicat",
    "sublime_text.exe": "Sublime Text",
    "cursor.exe": "Cursor",
    "Cursor.exe": "Cursor",
    "studio64.exe": "Android Studio",
    "clion64.exe": "CLion",
    "rustrover64.exe": "RustRover",
    "fleet.exe": "JetBrains Fleet",
    "HBuilder.exe": "HBuilderX",
    "HBuilderX.exe": "HBuilderX",
    "Skype.exe": "Skype",
    "Slack.exe": "Slack",
    "Feishu.exe": "\u98DE\u4E66",
    "Lark.exe": "Lark",
    "vim.exe": "Vim",
    "nvim.exe": "Neovim",
    "emacs.exe": "Emacs",
    "notepad++.exe": "Notepad++",
    "Insomnia.exe": "Insomnia",
    "Wireshark.exe": "Wireshark",
    "Fiddler.exe": "Fiddler",
    "gitkraken.exe": "GitKraken",
    "SourceTree.exe": "Sourcetree",
    "Figma.exe": "Figma",
    "Photoshop.exe": "Photoshop",
    "Illustrator.exe": "Illustrator",
    "Adobe Premiere Pro.exe": "Premiere Pro",
    "AfterFX.exe": "After Effects",
    "blender.exe": "Blender",
    "CINEMA 4D.exe": "Cinema 4D",
    "gimp-2.10.exe": "GIMP",
    "gimp.exe": "GIMP",
    "Resolve.exe": "DaVinci Resolve",
    "JianyingPro.exe": "\u526A\u6620",
    "Lightroom.exe": "Lightroom",
    "InDesign.exe": "InDesign",
    "PaintDotNet.exe": "Paint.NET",
    "sai2.exe": "SAI",
    "sai.exe": "SAI",
    "CLIPStudioPaint.exe": "Clip Studio Paint",
    "krita.exe": "Krita",
    "EpicGamesLauncher.exe": "Epic Games",
    "LeagueClient.exe": "League of Legends",
    "GenshinImpact.exe": "Genshin Impact",
    "YuanShen.exe": "\u539F\u795E",
    "StarRail.exe": "Honkai: Star Rail",
    "VALORANT.exe": "VALORANT",
    "cs2.exe": "Counter-Strike 2",
    "Overwatch.exe": "Overwatch",
    "r5apex.exe": "Apex Legends",
    "eldenring.exe": "Elden Ring",
    "Roblox.exe": "Roblox",
    "RobloxPlayerBeta.exe": "Roblox",
    "GalaxyClient.exe": "GOG Galaxy",
    "XboxApp.exe": "Xbox",
    "EADesktop.exe": "EA App",
    "UbisoftConnect.exe": "Ubisoft Connect",
    "Battle.net.exe": "Battle.net",
    "mpv.exe": "mpv",
    "qbittorrent.exe": "qBittorrent",
    "Thunder.exe": "\u8FC5\u96F7",
    "IDMan.exe": "IDM",
    "Motrix.exe": "Motrix",
    "TeamViewer.exe": "TeamViewer",
    "ToDesk.exe": "ToDesk",
    "wemeetapp.exe": "\u817E\u8BAF\u4F1A\u8BAE",
    "Zoom.exe": "Zoom",
    "ms-teams.exe": "Microsoft Teams",
    "Teams.exe": "Microsoft Teams",
    "v2rayN.exe": "v2rayN",
    "WPS.exe": "WPS Office",
    "wps.exe": "WPS Office",
    "OneDrive.exe": "OneDrive",
    "baidunetdisk.exe": "\u767E\u5EA6\u7F51\u76D8",
    "aDrive.exe": "\u963F\u91CC\u4E91\u76D8",
    "Dropbox.exe": "Dropbox",
    "Kindle.exe": "Kindle",
    "Audacity.exe": "Audacity",
    "foobar2000.exe": "foobar2000",
    "AIMP.exe": "AIMP",
    "Logseq.exe": "Logseq",
    "control.exe": "\u63A7\u5236\u9762\u677F",
    "alacritty.exe": "Alacritty",
    "warp.exe": "Warp",
    "ChatGPT.exe": "ChatGPT",
    "Ollama.exe": "Ollama",
    "lms.exe": "LM Studio",
    "Minecraft.exe": "Minecraft",
    "javaw.exe": "Minecraft"
  },
  android: {
    "com.tencent.mm": "\u5FAE\u4FE1",
    "com.tencent.mobileqq": "QQ",
    "com.tencent.tim": "TIM",
    "com.eg.android.AlipayGphone": "\u652F\u4ED8\u5B9D",
    "com.taobao.taobao": "\u6DD8\u5B9D",
    "com.jingdong.app.mall": "\u4EAC\u4E1C",
    "com.xunmeng.pinduoduo": "\u62FC\u591A\u591A",
    "com.ss.android.ugc.aweme": "\u6296\u97F3",
    "com.ss.android.article.news": "\u4ECA\u65E5\u5934\u6761",
    "tv.danmaku.bili": "\u54D4\u54E9\u54D4\u54E9",
    "com.bilibili.app.in": "\u54D4\u54E9\u54D4\u54E9",
    "com.netease.cloudmusic": "\u7F51\u6613\u4E91\u97F3\u4E50",
    "com.kugou.android": "\u9177\u72D7\u97F3\u4E50",
    "com.tencent.qqmusic": "QQ\u97F3\u4E50",
    "com.sina.weibo": "\u5FAE\u535A",
    "com.zhihu.android": "\u77E5\u4E4E",
    "com.xiaomi.market": "\u5C0F\u7C73\u5E94\u7528\u5546\u5E97",
    "com.android.chrome": "Chrome",
    "com.android.browser": "\u6D4F\u89C8\u5668",
    "com.mi.globalbrowser": "\u5C0F\u7C73\u6D4F\u89C8\u5668",
    "com.mi.browser": "\u5C0F\u7C73\u6D4F\u89C8\u5668",
    "com.heytap.browser": "HeyTap Browser",
    "com.vivo.browser": "Vivo Browser",
    "com.huawei.browser": "Huawei Browser",
    "com.sec.android.app.sbrowser": "Samsung Internet",
    "com.duckduckgo.mobile.android": "DuckDuckGo",
    "mark.via.gp": "Via",
    "com.kiwibrowser.browser": "Kiwi Browser",
    "com.quark.browser": "Quark",
    "com.UCMobile.intl": "UC Browser",
    "org.mozilla.firefox": "Firefox",
    "org.telegram.messenger": "Telegram",
    "com.spotify.music": "Spotify",
    "com.discord": "Discord",
    "com.github.android": "GitHub",
    "com.termux": "Termux",
    "com.reddit.frontpage": "Reddit",
    "com.twitter.android": "X",
    "com.google.android.youtube": "YouTube",
    "com.miui.home": "\u684C\u9762",
    "com.android.systemui": "\u7CFB\u7EDF\u754C\u9762",
    "com.android.settings": "\u8BBE\u7F6E",
    "com.miui.securitycenter": "\u624B\u673A\u7BA1\u5BB6",
    "com.xiaomi.misettings": "\u5C0F\u7C73\u8BBE\u7F6E",
    "com.android.camera": "\u76F8\u673A",
    "com.miui.gallery": "\u76F8\u518C",
    "com.android.fileexplorer": "\u6587\u4EF6\u7BA1\u7406",
    "com.miui.calculator": "\u8BA1\u7B97\u5668",
    "com.android.calendar": "\u65E5\u5386",
    "com.android.deskclock": "\u65F6\u949F",
    "com.coolapk.market": "\u9177\u5B89",
    "com.tencent.wework": "\u4F01\u4E1A\u5FAE\u4FE1",
    "com.alibaba.android.rimet": "\u9489\u9489",
    "com.baidu.searchbox": "\u767E\u5EA6",
    "com.baidu.BaiduMap": "\u767E\u5EA6\u5730\u56FE",
    "com.autonavi.minimap": "\u9AD8\u5FB7\u5730\u56FE",
    "com.dianping.v1": "\u5927\u4F17\u70B9\u8BC4",
    "com.sankuai.meituan": "\u7F8E\u56E2",
    "me.ele.crowdsource": "\u997F\u4E86\u4E48",
    "com.achievo.vipshop": "\u552F\u54C1\u4F1A",
    "com.MobileTicket": "\u94C1\u8DEF12306",
    "com.ctrip.ticket": "\u643A\u7A0B",
    "com.openai.chatgpt": "ChatGPT",
    "com.anthropic.claude": "Claude",
    "com.google.android.apps.bard": "Gemini",
    "com.moonshot.kimichat": "Kimi",
    "com.larus.nova": "\u8C46\u5305",
    "com.deepseek.chat": "DeepSeek",
    "com.instagram.android": "Instagram",
    "com.facebook.katana": "Facebook",
    "com.pinterest": "Pinterest",
    "com.zhiliaoapp.musically": "TikTok",
    "com.smile.gifmaker": "\u5FEB\u624B",
    "com.kuaishou.nebula": "\u5FEB\u624B",
    "tv.danmaku.bilibilihd": "\u54D4\u54E9\u54D4\u54E9",
    "com.bilibili.comic": "B\u7AD9\u6F2B\u753B",
    "com.tencent.karaoke": "QQ\u97F3\u4E50",
    "com.kugou.android.lite": "\u9177\u72D7\u97F3\u4E50",
    "com.tencent.tmgp.sgame": "\u738B\u8005\u8363\u8000",
    "com.tencent.ig": "\u548C\u5E73\u7CBE\u82F1",
    "com.miHoYo.Yuanshen": "\u539F\u795E",
    "com.miHoYo.hkrpg": "\u5D29\u574F\uFF1A\u661F\u7A79\u94C1\u9053",
    "com.miHoYo.zzz": "\u7EDD\u533A\u96F6",
    "com.kurogame.wutheringwaves": "\u9E23\u6F6E",
    "com.hypergryph.arknights": "\u660E\u65E5\u65B9\u821F",
    "com.tencent.meeting": "\u817E\u8BAF\u4F1A\u8BAE",
    "us.zoom.videomeetings": "Zoom",
    "com.microsoft.teams": "Microsoft Teams",
    "com.google.android.apps.meetings": "Google Meet",
    "com.taobao.idlefish": "\u95F2\u9C7C",
    "com.android.vending": "Google Play",
    "com.google.android.apps.maps": "Google Maps",
    "com.sdu.didi.psnger": "\u6EF4\u6EF4\u51FA\u884C",
    "com.taobao.trip": "\u98DE\u732A",
    "com.amazon.mShop.android.shopping": "Amazon",
    "com.tencent.weread": "\u5FAE\u4FE1\u8BFB\u4E66",
    "com.duokan.reader": "\u591A\u770B\u9605\u8BFB",
    "com.miui.weather2": "\u5929\u6C14",
    "com.miui.notes": "\u4FBF\u7B7E",
    "com.miui.barcodescanner": "\u626B\u4E00\u626B",
    "com.miui.voiceassist": "\u5F55\u97F3\u673A",
    "com.lemon.lv": "\u526A\u6620",
    "com.ss.android.ugc.trill": "TikTok",
    "com.xiaohongshu.discover": "\u5C0F\u7EA2\u4E66"
  },
  macos: {
    Code: "Visual Studio Code",
    Cursor: "Cursor",
    Windsurf: "Windsurf",
    Zed: "Zed",
    Xcode: "Xcode",
    "Android Studio": "Android Studio",
    "IntelliJ IDEA": "IntelliJ IDEA",
    PyCharm: "PyCharm",
    WebStorm: "WebStorm",
    GoLand: "GoLand",
    Rider: "JetBrains Rider",
    DataGrip: "DataGrip",
    CLion: "CLion",
    RustRover: "RustRover",
    Fleet: "JetBrains Fleet",
    "Sublime Text": "Sublime Text",
    "Google Chrome": "Google Chrome",
    Safari: "Safari",
    Firefox: "Firefox",
    Arc: "Arc",
    "Brave Browser": "Brave",
    Vivaldi: "Vivaldi",
    Opera: "Opera",
    "Microsoft Edge": "Microsoft Edge",
    Spotify: "Spotify",
    Music: "Apple Music",
    Discord: "Discord",
    WeChat: "\u5FAE\u4FE1",
    Telegram: "Telegram",
    Slack: "Slack",
    Feishu: "\u98DE\u4E66",
    "zoom.us": "Zoom",
    "Microsoft Teams": "Microsoft Teams",
    Finder: "Finder",
    Terminal: "Terminal",
    iTerm2: "iTerm2",
    Warp: "Warp",
    Alacritty: "Alacritty",
    Kitty: "Kitty",
    "Activity Monitor": "Activity Monitor",
    "System Preferences": "\u7CFB\u7EDF\u504F\u597D\u8BBE\u7F6E",
    "System Settings": "\u7CFB\u7EDF\u8BBE\u7F6E",
    Figma: "Figma",
    Sketch: "Sketch",
    Photoshop: "Photoshop",
    Illustrator: "Illustrator",
    "Premiere Pro": "Premiere Pro",
    "After Effects": "After Effects",
    "Final Cut Pro": "Final Cut Pro",
    "DaVinci Resolve": "DaVinci Resolve",
    Blender: "Blender",
    GIMP: "GIMP",
    "Pixelmator Pro": "Pixelmator",
    "Affinity Photo": "Affinity Photo",
    "Affinity Designer": "Affinity Designer",
    "Clip Studio Paint": "Clip Studio Paint",
    "Microsoft Word": "Word",
    "Microsoft Excel": "Excel",
    "Microsoft PowerPoint": "PowerPoint",
    "Microsoft OneNote": "OneNote",
    Notion: "Notion",
    Obsidian: "Obsidian",
    Typora: "Typora",
    Logseq: "Logseq",
    Pages: "Pages",
    Numbers: "Numbers",
    Keynote: "Keynote",
    Steam: "Steam",
    "Epic Games Launcher": "Epic Games",
    VLC: "VLC",
    IINA: "IINA",
    mpv: "mpv",
    Infuse: "Infuse",
    "Docker Desktop": "Docker Desktop",
    "GitHub Desktop": "GitHub Desktop",
    Postman: "Postman",
    TablePlus: "TablePlus",
    "Sequel Pro": "Sequel Pro",
    DBngin: "DBngin",
    Insomnia: "Insomnia",
    Proxyman: "Proxyman",
    Charles: "Charles Proxy",
    Wireshark: "Wireshark",
    Fork: "Fork",
    Tower: "Tower",
    SourceTree: "Sourcetree",
    GitKraken: "GitKraken",
    "Transmit 5": "Transmit",
    Cyberduck: "Cyberduck",
    ClashX: "ClashX",
    Surge: "Surge",
    Shadowrocket: "Shadowrocket",
    Kindle: "Kindle",
    Books: "Apple Books",
    NetNewsWire: "NetNewsWire",
    Reeder: "Reeder",
    Mail: "\u90AE\u4EF6",
    Mimestream: "Mimestream",
    Spark: "Spark",
    Notes: "\u5907\u5FD8\u5F55",
    Reminders: "\u63D0\u9192\u4E8B\u9879",
    Calendar: "\u65E5\u5386",
    Maps: "\u5730\u56FE",
    Photos: "\u7167\u7247",
    Preview: "\u9884\u89C8",
    ScreenFlow: "ScreenFlow",
    OmniGraffle: "OmniGraffle",
    Audacity: "Audacity",
    GarageBand: "GarageBand",
    "Logic Pro": "Logic Pro",
    "Ableton Live": "Ableton Live"
  }
};

// packages/backend/src/services/app-mapper.ts
var windowsMap = new Map;
for (const [key, value] of Object.entries(app_names_default.windows)) {
  windowsMap.set(key.toLowerCase(), value);
}
var androidMap = new Map;
for (const [key, value] of Object.entries(app_names_default.android)) {
  androidMap.set(key.toLowerCase(), value);
}
var macosMap = new Map;
for (const [key, value] of Object.entries(app_names_default.macos)) {
  macosMap.set(key.toLowerCase(), value);
}
function resolveAppName(appId, platform) {
  if (!appId || typeof appId !== "string")
    return "Unknown";
  const lower = appId.toLowerCase();
  if (platform === "windows") {
    const found2 = windowsMap.get(lower);
    if (found2)
      return found2;
    if (lower.endsWith(".exe"))
      return appId.replace(/\.exe$/i, "");
    return appId;
  }
  if (platform === "android") {
    const found2 = androidMap.get(lower);
    if (found2)
      return found2;
    if (appId.includes(".")) {
      const parts = appId.split(".");
      const last = parts[parts.length - 1] || appId;
      return last.charAt(0).toUpperCase() + last.slice(1);
    }
    return appId;
  }
  if (platform === "zepp") {
    if (lower === "zepp_watch")
      return "Zepp Watch";
    return appId;
  }
  const found = macosMap.get(lower);
  return found ?? appId;
}
// packages/backend/src/data/nsfw-blocklist.json
var nsfw_blocklist_default = {
  domains: [
    "pornhub.com",
    "xvideos.com",
    "xhamster.com",
    "xnxx.com",
    "redtube.com",
    "youporn.com",
    "tube8.com",
    "spankbang.com",
    "eporner.com",
    "tnaflix.com",
    "nhentai.net",
    "hanime.tv",
    "hentaihaven.xxx",
    "rule34.xxx",
    "e-hentai.org",
    "exhentai.org",
    "gelbooru.com",
    "danbooru.donmai.us",
    "hitomi.la",
    "javbus.com",
    "javdb.com",
    "avgle.com",
    "missav.com",
    "thisav.com",
    "jable.tv",
    "91porn.com",
    "sex.com",
    "chaturbate.com",
    "stripchat.com",
    "cam4.com",
    "bongacams.com",
    "onlyfans.com",
    "fansly.com",
    "iwara.tv"
  ],
  keywords: [
    "pornhub",
    "xvideos",
    "xhamster",
    "nhentai",
    "hentai",
    "hanime",
    "rule34",
    "e-hentai",
    "exhentai",
    "gelbooru",
    "danbooru",
    "javbus",
    "javdb",
    "missav",
    "91porn",
    "onlyfans",
    "fansly",
    "chaturbate",
    "stripchat"
  ],
  app_ids: [
    "com.pornhub.android",
    "com.xvideos.app",
    "com.xhamster.app"
  ]
};

// packages/backend/src/services/nsfw-filter.ts
var domainSet = new Set(nsfw_blocklist_default.domains.map((d) => d.toLowerCase()));
var keywords = nsfw_blocklist_default.keywords.map((k) => k.toLowerCase());
var blockedAppIds = new Set(nsfw_blocklist_default.app_ids.map((a) => a.toLowerCase()));
function extractDomains(text) {
  const domains = [];
  const matches = text.match(/(?:https?:\/\/)?(?:www\.|m\.)?([a-z0-9][-a-z0-9]*(?:\.[a-z0-9][-a-z0-9]*)+)/gi);
  if (matches) {
    for (const m of matches) {
      const cleaned = m.replace(/^https?:\/\//i, "").replace(/^(?:www\.|m\.)/i, "").toLowerCase().split("/")[0];
      if (cleaned)
        domains.push(cleaned);
    }
  }
  return domains;
}
function isNSFW(appId, windowTitle) {
  if (!appId && !windowTitle)
    return false;
  const lowerAppId = (appId || "").toLowerCase();
  const lowerTitle = (windowTitle || "").toLowerCase();
  if (blockedAppIds.has(lowerAppId))
    return true;
  const domains = extractDomains(lowerTitle);
  for (const domain of domains) {
    let d = domain;
    while (d) {
      if (domainSet.has(d))
        return true;
      const dot = d.indexOf(".");
      if (dot === -1)
        break;
      d = d.slice(dot + 1);
    }
  }
  for (const keyword of keywords) {
    if (lowerTitle.includes(keyword))
      return true;
  }
  return false;
}

// packages/backend/src/services/privacy-tiers.ts
var tierMap = new Map;
function registerTier(tier, names) {
  for (const n of names) {
    tierMap.set(n.toLowerCase(), tier);
  }
}
registerTier("show", [
  "YouTube",
  "\u54D4\u54E9\u54D4\u54E9",
  "bilibili",
  "Netflix",
  "\u7231\u5947\u827A",
  "\u4F18\u9177",
  "\u817E\u8BAF\u89C6\u9891",
  "VLC",
  "PotPlayer",
  "mpv",
  "Twitch",
  "Disney+",
  "\u8292\u679CTV",
  "\u6597\u9C7C",
  "\u864E\u7259",
  "Prime Video",
  "HBO"
]);
registerTier("show", [
  "Spotify",
  "\u7F51\u6613\u4E91\u97F3\u4E50",
  "QQ\u97F3\u4E50",
  "\u9177\u72D7\u97F3\u4E50",
  "Apple Music",
  "foobar2000",
  "YouTube Music",
  "\u9177\u6211\u97F3\u4E50",
  "Amazon Music",
  "AIMP",
  "Audacity"
]);
registerTier("show", [
  "Steam",
  "Epic Games",
  "Genshin Impact",
  "\u539F\u795E",
  "League of Legends",
  "\u82F1\u96C4\u8054\u76DF",
  "Honkai: Star Rail",
  "\u5D29\u574F\uFF1A\u661F\u7A79\u94C1\u9053",
  "Minecraft",
  "\u738B\u8005\u8363\u8000",
  "\u548C\u5E73\u7CBE\u82F1",
  "VALORANT",
  "Counter-Strike 2",
  "CSGO",
  "Overwatch",
  "Apex Legends",
  "Elden Ring",
  "Zelda",
  "Roblox",
  "GOG Galaxy",
  "Xbox",
  "EA App",
  "Ubisoft Connect",
  "Battle.net",
  "\u660E\u65E5\u65B9\u821F",
  "Arknights",
  "\u7EDD\u533A\u96F6",
  "\u9E23\u6F6E",
  "\u3044\u308D\u3068\u308A\u3069\u308A\u306E\u30BB\u30AB\u30A4",
  "\u4E94\u5F69\u6591\u6593\u7684\u4E16\u754C",
  "FAVORITE",
  "\u3082\u306E\u3079\u306E",
  "CLANNAD",
  "Fate/stay night",
  "Summer Pockets",
  "\u30B5\u30DE\u30FC\u30DD\u30B1\u30C3\u30C4",
  "Doki Doki Literature Club",
  "WHITE ALBUM 2",
  "\u5343\u604B\uFF0A\u4E07\u82B1",
  "Making*Lovers",
  "Sabbat of the Witch",
  "\u30B5\u30CE\u30D0\u30A6\u30A3\u30C3\u30C1",
  "Riddle Joker",
  "\u55AB\u8336\u30B9\u30C6\u30E9\u3068\u6B7B\u795E\u306E\u8776",
  "Kirikiri",
  "KiriKiri",
  "BGI",
  "SiglusEngine",
  "Ethornell",
  "CatSystem2"
]);
registerTier("show", [
  "VS Code",
  "Visual Studio Code",
  "Visual Studio",
  "IntelliJ IDEA",
  "PyCharm",
  "WebStorm",
  "GoLand",
  "JetBrains Rider",
  "DataGrip",
  "Android Studio",
  "Cursor",
  "Sublime Text",
  "Google Antigravity",
  "Windsurf",
  "Zed",
  "CLion",
  "RustRover",
  "JetBrains Fleet",
  "HBuilderX",
  "Vim",
  "Neovim",
  "Emacs",
  "Notepad++"
]);
registerTier("show", [
  "Docker Desktop",
  "GitHub Desktop",
  "Postman",
  "DBeaver",
  "Navicat",
  "Insomnia",
  "Wireshark",
  "Fiddler",
  "Charles Proxy",
  "GitKraken",
  "Sourcetree"
]);
registerTier("show", [
  "Figma",
  "Sketch",
  "Photoshop",
  "Adobe Photoshop",
  "Illustrator",
  "Adobe Illustrator",
  "Premiere Pro",
  "Adobe Premiere Pro",
  "After Effects",
  "Adobe After Effects",
  "Blender",
  "Cinema 4D",
  "GIMP",
  "Canva",
  "Adobe XD",
  "DaVinci Resolve",
  "\u526A\u6620",
  "CapCut",
  "Lightroom",
  "Adobe Lightroom",
  "InDesign",
  "Adobe InDesign",
  "Affinity Photo",
  "Affinity Designer",
  "Pixelmator",
  "Paint.NET",
  "SAI",
  "Clip Studio Paint",
  "MediBang",
  "Krita"
]);
registerTier("show", [
  "Word",
  "Microsoft Word",
  "Excel",
  "Microsoft Excel",
  "PowerPoint",
  "Microsoft PowerPoint",
  "OneNote",
  "Notion",
  "Obsidian",
  "Typora",
  "WPS Office",
  "WPS",
  "Google Docs",
  "Google Sheets",
  "Google Slides",
  "Logseq"
]);
registerTier("show", [
  "Kindle",
  "\u5FAE\u4FE1\u8BFB\u4E66",
  "\u591A\u770B\u9605\u8BFB",
  "Apple Books",
  "Calibre"
]);
registerTier("browser", [
  "Google Chrome",
  "Chrome",
  "Microsoft Edge",
  "Firefox",
  "Safari",
  "Opera",
  "Arc",
  "Brave",
  "Vivaldi",
  "Opera GX",
  "\u6D4F\u89C8\u5668",
  "\u5C0F\u7C73\u6D4F\u89C8\u5668",
  "Samsung Internet",
  "DuckDuckGo",
  "Via",
  "Kiwi Browser",
  "Quark",
  "UC Browser",
  "HeyTap Browser",
  "Vivo Browser",
  "Huawei Browser"
]);
registerTier("hide", [
  "Telegram",
  "QQ",
  "TIM",
  "\u5FAE\u4FE1",
  "WeChat",
  "Discord",
  "Line",
  "\u4F01\u4E1A\u5FAE\u4FE1",
  "\u9489\u9489",
  "Skype",
  "\u98DE\u4E66",
  "Lark",
  "Slack"
]);
registerTier("hide", [
  "ChatGPT",
  "Claude",
  "Gemini",
  "Copilot",
  "Microsoft Copilot",
  "\u901A\u4E49\u5343\u95EE",
  "\u6587\u5FC3\u4E00\u8A00",
  "Kimi",
  "\u8C46\u5305",
  "DeepSeek",
  "Poe",
  "Perplexity",
  "HuggingChat",
  "Ollama",
  "LM Studio"
]);
registerTier("hide", [
  "Outlook",
  "\u90AE\u4EF6",
  "Mail"
]);
registerTier("hide", [
  "\u6587\u4EF6\u8D44\u6E90\u7BA1\u7406\u5668",
  "File Explorer",
  "\u6587\u4EF6\u7BA1\u7406",
  "Finder",
  "Total Commander",
  "Windows Terminal",
  "\u7EC8\u7AEF",
  "Terminal",
  "PowerShell",
  "\u547D\u4EE4\u63D0\u793A\u7B26",
  "Command Prompt",
  "iTerm2",
  "Termux",
  "Alacritty",
  "Warp",
  "Kitty",
  "\u4EFB\u52A1\u7BA1\u7406\u5668",
  "Task Manager",
  "\u7CFB\u7EDF\u8BBE\u7F6E",
  "\u8BBE\u7F6E",
  "Settings",
  "\u5C0F\u7C73\u8BBE\u7F6E",
  "\u641C\u7D22",
  "\u8F93\u5165\u6CD5",
  "\u753B\u56FE",
  "UWP \u5E94\u7528",
  "\u7CFB\u7EDF Shell",
  "\u7CFB\u7EDF\u754C\u9762",
  "\u684C\u9762",
  "\u8BB0\u4E8B\u672C",
  "\u63A7\u5236\u9762\u677F",
  "Control Panel",
  "\u5929\u6C14",
  "\u5F55\u97F3\u673A",
  "\u626B\u4E00\u626B",
  "\u4FBF\u7B7E"
]);
registerTier("hide", [
  "Mihomo Party",
  "Clash",
  "Clash Verge",
  "v2rayN",
  "Shadowrocket",
  "Quantumult",
  "Surge",
  "NekoBox"
]);
registerTier("hide", [
  "\u6DD8\u5B9D",
  "\u4EAC\u4E1C",
  "\u62FC\u591A\u591A",
  "\u552F\u54C1\u4F1A",
  "\u7F8E\u56E2",
  "\u997F\u4E86\u4E48",
  "\u5927\u4F17\u70B9\u8BC4",
  "\u5C0F\u7C73\u5E94\u7528\u5546\u5E97",
  "\u94C1\u8DEF12306",
  "\u643A\u7A0B",
  "\u767E\u5EA6\u5730\u56FE",
  "\u9AD8\u5FB7\u5730\u56FE",
  "\u95F2\u9C7C",
  "Google Play",
  "App Store",
  "Google Maps",
  "\u6EF4\u6EF4\u51FA\u884C",
  "\u98DE\u732A"
]);
registerTier("hide", [
  "Twitter",
  "X",
  "\u5FAE\u535A",
  "\u5C0F\u7EA2\u4E66",
  "\u6296\u97F3",
  "TikTok",
  "\u77E5\u4E4E",
  "\u4ECA\u65E5\u5934\u6761",
  "Reddit",
  "GitHub",
  "\u9177\u5B89",
  "\u767E\u5EA6",
  "Instagram",
  "Facebook",
  "Pinterest",
  "Threads",
  "\u5FEB\u624B",
  "B\u7AD9\u6F2B\u753B",
  "\u76F8\u673A",
  "\u76F8\u518C",
  "\u8BA1\u7B97\u5668",
  "\u65E5\u5386",
  "\u65F6\u949F",
  "\u624B\u673A\u7BA1\u5BB6"
]);
registerTier("hide", [
  "qBittorrent",
  "\xB5Torrent",
  "BitComet",
  "\u8FC5\u96F7",
  "IDM",
  "Internet Download Manager",
  "Motrix",
  "Free Download Manager",
  "Google Drive",
  "OneDrive",
  "\u767E\u5EA6\u7F51\u76D8",
  "\u963F\u91CC\u4E91\u76D8",
  "Dropbox",
  "TeamViewer",
  "ToDesk",
  "\u5411\u65E5\u8475",
  "\u817E\u8BAF\u4F1A\u8BAE",
  "Zoom",
  "Microsoft Teams",
  "Google Meet",
  "\u9489\u9489\u4F1A\u8BAE",
  "\u98DE\u4E66\u4F1A\u8BAE",
  "Trello",
  "Todoist",
  "\u5370\u8C61\u7B14\u8BB0",
  "Evernote",
  "\u652F\u4ED8\u5B9D"
]);
function getPrivacyTier(appName) {
  if (!appName)
    return "hide";
  return tierMap.get(appName.toLowerCase()) ?? "show";
}
var browserSuffixes = [
  " - Google Chrome",
  " \u2014 Mozilla Firefox",
  " - Mozilla Firefox",
  " - Microsoft Edge",
  " - Opera",
  " - Arc",
  " - Brave",
  " - Vivaldi"
];
var sensitiveKeywords = [
  "gmail",
  "outlook",
  "mail",
  "inbox",
  "\u90AE\u7BB1",
  "\u90AE\u4EF6",
  "telegram",
  "discord",
  "messenger",
  "whatsapp",
  "signal",
  "slack",
  "teams",
  "\u804A\u5929",
  "\u79C1\u4FE1",
  "\u6D88\u606F",
  "login",
  "log in",
  "\u767B\u5F55",
  "signin",
  "sign in",
  "signup",
  "sign up",
  "\u6CE8\u518C",
  "password",
  "\u5BC6\u7801",
  "\u9A8C\u8BC1\u7801",
  "verification",
  "two-factor",
  "2fa",
  "otp",
  "authenticate",
  "authorization",
  "bank",
  "\u94F6\u884C",
  "\u652F\u4ED8",
  "\u4ED8\u6B3E",
  "payment",
  "checkout",
  "\u7ED3\u7B97",
  "\u4FE1\u7528\u5361",
  "credit card",
  "debit card",
  "\u501F\u8BB0\u5361",
  "wallet",
  "\u94B1\u5305",
  "\u8F6C\u8D26",
  "transfer",
  "\u4F59\u989D",
  "balance",
  "alipay",
  "\u652F\u4ED8\u5B9D",
  "wechat pay",
  "\u5FAE\u4FE1\u652F\u4ED8",
  "paypal",
  "venmo",
  "zelle",
  "invoice",
  "\u53D1\u7968",
  "\u8D26\u5355",
  "billing",
  "order",
  "\u8BA2\u5355",
  "my account",
  "\u6211\u7684\u8D26\u6237",
  "\u4E2A\u4EBA\u4E2D\u5FC3",
  "account settings",
  "\u8D26\u6237\u8BBE\u7F6E",
  "medical",
  "health",
  "\u533B\u9662",
  "\u75C5\u5386",
  "\u5C31\u8BCA",
  "insurance",
  "\u4FDD\u9669",
  "admin",
  "dashboard",
  "\u7BA1\u7406\u540E\u53F0",
  "\u63A7\u5236\u53F0",
  "vpn",
  "proxy",
  "\u4EE3\u7406"
];
var videoSiteKeywords = [
  "youtube",
  "bilibili",
  "b\u7AD9",
  "\u54D4\u54E9\u54D4\u54E9",
  "netflix",
  "\u7231\u5947\u827A",
  "\u4F18\u9177",
  "\u817E\u8BAF\u89C6\u9891",
  "twitch",
  "niconico"
];
function stripZeroWidth(s) {
  return s.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
}
function stripBrowserSuffix(title) {
  const cleaned = stripZeroWidth(title);
  const lower = cleaned.toLowerCase();
  const edgeProfileRe = /\s-\s[^-]+\s-\sMicrosoft\s*Edge$/i;
  const m = edgeProfileRe.exec(cleaned);
  if (m && m.index !== undefined) {
    return cleaned.slice(0, m.index).trim();
  }
  for (const suffix of browserSuffixes) {
    if (lower.endsWith(suffix.toLowerCase())) {
      return cleaned.slice(0, -suffix.length).trim();
    }
  }
  return cleaned;
}
function isSensitiveBrowserTitle(title) {
  const lower = title.toLowerCase();
  return sensitiveKeywords.some((kw) => lower.includes(kw));
}
function isVideoSiteTitle(title) {
  const lower = title.toLowerCase();
  return videoSiteKeywords.some((kw) => lower.includes(kw));
}
var appSuffixes = [
  " - YouTube",
  " - Netflix",
  " _ \u54D4\u54E9\u54D4\u54E9_bilibili",
  "_\u54D4\u54E9\u54D4\u54E9_bilibili",
  " - \u54D4\u54E9\u54D4\u54E9",
  " - \u7231\u5947\u827A",
  " - \u4F18\u9177",
  " - \u817E\u8BAF\u89C6\u9891"
];
function stripAppSuffix(title) {
  const cleaned = stripZeroWidth(title);
  const lower = cleaned.toLowerCase();
  for (const suffix of appSuffixes) {
    if (lower.endsWith(suffix.toLowerCase())) {
      return cleaned.slice(0, -suffix.length).trim();
    }
  }
  return cleaned;
}
function extractMusicTitle(appName, title) {
  if (!title)
    return "";
  const lower = title.toLowerCase();
  if (lower === "spotify" || lower === "spotify premium" || lower === "spotify free")
    return "";
  if (lower === "\u7F51\u6613\u4E91\u97F3\u4E50")
    return "";
  if (lower === "qq\u97F3\u4E50")
    return "";
  if (appName.toLowerCase() === "foobar2000") {
    let cleaned = title.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, "");
    cleaned = cleaned.replace(/\s*\[foobar2000\]$/i, "");
    return cleaned.trim();
  }
  return stripAppSuffix(title).trim();
}
function extractIDETitle(title) {
  if (!title)
    return "";
  if (title.includes(" \u2014 ")) {
    const parts = title.split(" \u2014 ");
    if (parts.length >= 2) {
      const meaningful = parts.slice(0, -1).join(" \u2014 ");
      return meaningful.trim();
    }
  }
  if (title.includes(" \u2013 ")) {
    const parts = title.split(" \u2013 ");
    return (parts[0] || title).trim();
  }
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
function extractDocTitle(title) {
  if (!title)
    return "";
  if (title.includes(" \u2014 ")) {
    const parts = title.split(" \u2014 ");
    if (parts.length >= 2) {
      return parts.slice(0, -1).join(" \u2014 ").trim();
    }
  }
  if (title.includes(" - ")) {
    const parts = title.split(" - ");
    if (parts.length >= 2) {
      return parts.slice(0, -1).join(" - ").trim();
    }
  }
  return title.trim();
}
var musicApps = new Set([
  "spotify",
  "\u7F51\u6613\u4E91\u97F3\u4E50",
  "qq\u97F3\u4E50",
  "\u9177\u72D7\u97F3\u4E50",
  "apple music",
  "foobar2000",
  "youtube music",
  "\u9177\u6211\u97F3\u4E50",
  "amazon music",
  "aimp"
]);
var ideApps = new Set([
  "vs code",
  "visual studio code",
  "visual studio",
  "intellij idea",
  "pycharm",
  "webstorm",
  "goland",
  "jetbrains rider",
  "datagrip",
  "android studio",
  "cursor",
  "sublime text",
  "google antigravity",
  "windsurf",
  "zed",
  "clion",
  "rustrover",
  "jetbrains fleet",
  "hbuilderx",
  "vim",
  "neovim",
  "emacs",
  "notepad++",
  "docker desktop",
  "github desktop",
  "postman",
  "dbeaver",
  "navicat",
  "insomnia",
  "wireshark",
  "fiddler",
  "charles proxy",
  "gitkraken",
  "sourcetree"
]);
var videoApps = new Set([
  "youtube",
  "\u54D4\u54E9\u54D4\u54E9",
  "bilibili",
  "netflix",
  "\u7231\u5947\u827A",
  "\u4F18\u9177",
  "\u817E\u8BAF\u89C6\u9891",
  "vlc",
  "potplayer",
  "mpv",
  "twitch",
  "disney+",
  "\u8292\u679Ctv",
  "\u6597\u9C7C",
  "\u864E\u7259",
  "prime video",
  "hbo"
]);
var docApps = new Set([
  "word",
  "microsoft word",
  "excel",
  "microsoft excel",
  "powerpoint",
  "microsoft powerpoint",
  "onenote",
  "notion",
  "obsidian",
  "typora",
  "wps office",
  "wps",
  "google docs",
  "google sheets",
  "google slides",
  "logseq"
]);
var designApps = new Set([
  "figma",
  "sketch",
  "photoshop",
  "adobe photoshop",
  "illustrator",
  "adobe illustrator",
  "premiere pro",
  "adobe premiere pro",
  "after effects",
  "adobe after effects",
  "blender",
  "cinema 4d",
  "gimp",
  "canva",
  "adobe xd",
  "davinci resolve",
  "\u526A\u6620",
  "capcut",
  "lightroom",
  "adobe lightroom",
  "indesign",
  "adobe indesign",
  "affinity photo",
  "affinity designer",
  "pixelmator",
  "paint.net",
  "sai",
  "clip studio paint",
  "medibang",
  "krita"
]);
function processDisplayTitle(appName, windowTitle) {
  if (!appName || !windowTitle)
    return "";
  const tier = getPrivacyTier(appName);
  const lowerApp = appName.toLowerCase();
  if (tier === "hide") {
    return "";
  }
  if (tier === "browser") {
    const pageTitle = stripBrowserSuffix(windowTitle);
    if (!pageTitle)
      return "";
    if (isSensitiveBrowserTitle(pageTitle))
      return "";
    if (isVideoSiteTitle(pageTitle)) {
      return stripAppSuffix(pageTitle).trim() || "";
    }
    return pageTitle;
  }
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
  return windowTitle.trim();
}

// packages/backend/src/services/device-status-handler.ts
init_db();
var NSFW_FILTER_ENABLED = process.env.NSFW_FILTER_DISABLED !== "true";
var MAX_TITLE_LENGTH = 256;
var MAX_SHORT_LENGTH = 64;
var MAX_MEDIUM_LENGTH = 256;
var VALID_SOURCES = new Set(["normal", "root", "lsposed", "accessibility", "notification"]);
var getPreviousDeviceExtra = db.prepare("SELECT extra FROM device_states WHERE device_id = ?");
function cleanString(value, max) {
  if (typeof value !== "string")
    return;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}
function cleanSource(value) {
  return typeof value === "string" && VALID_SOURCES.has(value) ? value : undefined;
}
function cleanTimestamp(value) {
  if (typeof value !== "string" || !value)
    return;
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}
function cleanFiniteNumber(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : undefined;
}
function processReportPayload(body, device) {
  const rawExtra = body.extra && typeof body.extra === "object" && !Array.isArray(body.extra) ? body.extra : null;
  const rawForeground = rawExtra?.foreground && typeof rawExtra.foreground === "object" && !Array.isArray(rawExtra.foreground) ? rawExtra.foreground : null;
  const sleepingFallback = rawExtra?.sleeping === true;
  const foregroundPackageFallback = cleanString(rawForeground?.package_name, MAX_SHORT_LENGTH) || "";
  const appId = typeof body.app_id === "string" ? body.app_id.trim() : foregroundPackageFallback || (sleepingFallback ? "sleeping" : "");
  if (!appId)
    return null;
  let windowTitle = typeof body.window_title === "string" ? body.window_title : "";
  if (windowTitle.length > MAX_TITLE_LENGTH) {
    windowTitle = windowTitle.slice(0, MAX_TITLE_LENGTH);
  }
  let startedAt;
  if (typeof body.timestamp === "string" && body.timestamp) {
    const ts = new Date(body.timestamp);
    const now = Date.now();
    if (!isNaN(ts.getTime()) && Math.abs(ts.getTime() - now) < 5 * 60 * 1000) {
      startedAt = ts.toISOString();
    } else {
      startedAt = new Date().toISOString();
    }
  } else {
    startedAt = new Date().toISOString();
  }
  if (NSFW_FILTER_ENABLED && isNSFW(appId, windowTitle))
    return null;
  const rawForegroundForName = rawExtra?.foreground ?? null;
  const reportedAppName = rawForegroundForName && typeof rawForegroundForName === "object" && !Array.isArray(rawForegroundForName) ? cleanString(rawForegroundForName.app_name, MAX_SHORT_LENGTH) : undefined;
  const appName = appId === "sleeping" ? "sleeping" : device.platform === "android" && reportedAppName ? reportedAppName : resolveAppName(appId, device.platform);
  const displayTitle = processDisplayTitle(appName, windowTitle);
  const timeBucket = Math.floor(Date.now() / 1e4);
  const titleHash = hmacTitle(windowTitle.toLowerCase().trim());
  const extra = {};
  if (rawExtra) {
    if (typeof rawExtra.battery_percent === "number" && Number.isFinite(rawExtra.battery_percent)) {
      extra.battery_percent = Math.max(0, Math.min(100, Math.round(rawExtra.battery_percent)));
    }
    if (typeof rawExtra.battery_charging === "boolean") {
      extra.battery_charging = rawExtra.battery_charging;
    }
    if (typeof rawExtra.sleeping === "boolean") {
      extra.sleeping = rawExtra.sleeping;
    }
    const rawDevice = rawExtra.device;
    if (rawDevice != null && typeof rawDevice === "object" && !Array.isArray(rawDevice)) {
      const deviceBody = rawDevice;
      const deviceExtra = {};
      if (typeof deviceBody.network_connected === "boolean")
        deviceExtra.network_connected = deviceBody.network_connected;
      const networkType = cleanString(deviceBody.network_type, MAX_SHORT_LENGTH);
      if (networkType)
        deviceExtra.network_type = networkType;
      const cellularGeneration = cleanString(deviceBody.cellular_generation, MAX_SHORT_LENGTH);
      if (cellularGeneration)
        deviceExtra.cellular_generation = cellularGeneration;
      if (typeof deviceBody.vpn_active === "boolean")
        deviceExtra.vpn_active = deviceBody.vpn_active;
      const vpnName = cleanString(deviceBody.vpn_name, MAX_SHORT_LENGTH);
      if (vpnName)
        deviceExtra.vpn_name = vpnName;
      const capabilityMode = cleanSource(deviceBody.capability_mode);
      if (capabilityMode)
        deviceExtra.capability_mode = capabilityMode;
      const uploader = cleanSource(deviceBody.uploader);
      if (uploader)
        deviceExtra.uploader = uploader;
      const lastSampleAt = cleanTimestamp(deviceBody.last_sample_at);
      if (lastSampleAt)
        deviceExtra.last_sample_at = lastSampleAt;
      const relayMode = cleanString(deviceBody.relay_mode, MAX_SHORT_LENGTH);
      if (relayMode)
        deviceExtra.relay_mode = relayMode;
      const energyPolicy = cleanString(deviceBody.energy_policy, MAX_SHORT_LENGTH);
      if (energyPolicy)
        deviceExtra.energy_policy = energyPolicy;
      const minIntervalMs = cleanFiniteNumber(deviceBody.min_interval_ms, 0, 24 * 60 * 60 * 1000);
      if (minIntervalMs != null)
        deviceExtra.min_interval_ms = Math.round(minIntervalMs);
      const deviceKind = cleanString(deviceBody.device_kind, MAX_SHORT_LENGTH);
      if (deviceKind)
        deviceExtra.device_kind = deviceKind;
      const windowMode = cleanString(deviceBody.window_mode, MAX_SHORT_LENGTH);
      if (windowMode)
        deviceExtra.window_mode = windowMode;
      if (Object.keys(deviceExtra).length > 0)
        extra.device = deviceExtra;
    }
    const rawLocation = rawExtra.location;
    if (rawLocation != null && typeof rawLocation === "object" && !Array.isArray(rawLocation)) {
      const locationBody = rawLocation;
      const latitude = cleanFiniteNumber(locationBody.latitude, -90, 90);
      const longitude = cleanFiniteNumber(locationBody.longitude, -180, 180);
      if (latitude != null && longitude != null) {
        const recordedAt = cleanTimestamp(locationBody.recorded_at) || startedAt;
        const accuracy = cleanFiniteNumber(locationBody.accuracy_m, 0, 1e5);
        const provider = cleanString(locationBody.provider, MAX_SHORT_LENGTH) || "";
        extra.location = {
          latitude,
          longitude,
          ...accuracy != null ? { accuracy_m: accuracy } : {},
          ...provider ? { provider } : {},
          recorded_at: recordedAt
        };
        try {
          insertLocationRecord.run(device.device_id, latitude, longitude, accuracy ?? null, provider, recordedAt);
        } catch (e) {
          if (!e.message?.includes("UNIQUE constraint")) {
            console.error("[report] Location insert error:", e.message);
          }
        }
      }
    }
    const rawForeground2 = rawExtra.foreground;
    if (rawForeground2 != null && typeof rawForeground2 === "object" && !Array.isArray(rawForeground2)) {
      const foregroundBody = rawForeground2;
      const foreground = {};
      const packageName = cleanString(foregroundBody.package_name, MAX_SHORT_LENGTH);
      const appNameExtra = cleanString(foregroundBody.app_name, MAX_SHORT_LENGTH);
      const activity = cleanString(foregroundBody.activity, MAX_MEDIUM_LENGTH);
      const title = cleanString(foregroundBody.title, MAX_MEDIUM_LENGTH);
      const source = cleanSource(foregroundBody.source);
      if (packageName)
        foreground.package_name = packageName;
      if (appNameExtra)
        foreground.app_name = appNameExtra;
      if (activity)
        foreground.activity = activity;
      if (title && displayTitle)
        foreground.title = displayTitle;
      if (source)
        foreground.source = source;
      if (typeof foregroundBody.confidence === "number" && Number.isFinite(foregroundBody.confidence)) {
        foreground.confidence = Math.max(0, Math.min(1, foregroundBody.confidence));
      }
      if (Object.keys(foreground).length > 0)
        extra.foreground = foreground;
    }
    const rawInput = rawExtra.input;
    if (rawInput != null && typeof rawInput === "object" && !Array.isArray(rawInput)) {
      const inputBody = rawInput;
      const input = {};
      if (typeof inputBody.input_active === "boolean")
        input.input_active = inputBody.input_active;
      if (typeof inputBody.is_typing === "boolean")
        input.is_typing = inputBody.is_typing;
      const source = cleanSource(inputBody.source);
      if (source)
        input.source = source;
      if (Object.keys(input).length > 0)
        extra.input = input;
    }
    const rawMusic = rawExtra.music;
    if (rawMusic != null && typeof rawMusic === "object" && !Array.isArray(rawMusic)) {
      const music = {};
      if (typeof rawMusic.title === "string")
        music.title = rawMusic.title.slice(0, 256);
      if (typeof rawMusic.artist === "string")
        music.artist = rawMusic.artist.slice(0, 256);
      if (typeof rawMusic.app === "string")
        music.app = rawMusic.app.slice(0, 64);
      if (Object.keys(music).length > 0) {
        extra.music = music;
      }
    }
    const rawMedia = rawExtra.media;
    if (rawMedia != null && typeof rawMedia === "object" && !Array.isArray(rawMedia)) {
      const mediaBody = rawMedia;
      const media = {};
      if (typeof mediaBody.playing === "boolean")
        media.playing = mediaBody.playing;
      const title = cleanString(mediaBody.title, MAX_MEDIUM_LENGTH);
      const artist = cleanString(mediaBody.artist, MAX_MEDIUM_LENGTH);
      const mediaApp = cleanString(mediaBody.app, MAX_SHORT_LENGTH);
      const mediaPackage = cleanString(mediaBody.package_name, MAX_SHORT_LENGTH);
      const state = cleanString(mediaBody.state, MAX_SHORT_LENGTH);
      const source = cleanSource(mediaBody.source);
      if (title)
        media.title = title;
      if (artist)
        media.artist = artist;
      if (mediaApp)
        media.app = mediaApp;
      if (mediaPackage)
        media.package_name = mediaPackage;
      if (state)
        media.state = state;
      if (source)
        media.source = source;
      if (Object.keys(media).length > 0)
        extra.media = media;
    }
  }
  mergeStableDeviceExtra(device.device_id, extra);
  const extraJson = JSON.stringify(extra);
  try {
    if (device.platform !== "zepp") {
      insertActivity.run(device.device_id, device.device_name, device.platform, appId, appName, windowTitle, displayTitle, titleHash, timeBucket, startedAt);
    }
  } catch (e) {
    if (!e.message?.includes("UNIQUE constraint")) {
      console.error("[report] DB insert error:", e.message);
    }
  }
  try {
    upsertDeviceState.run(device.device_id, device.device_name, device.platform, appId, appName, windowTitle, displayTitle, new Date().toISOString(), extraJson);
  } catch (e) {
    console.error("[report] Device state update error:", e.message);
  }
  return {
    app_id: appId,
    app_name: appName,
    display_title: displayTitle,
    extra
  };
}
function mergeStableDeviceExtra(deviceId, extra) {
  const row = getPreviousDeviceExtra.get(deviceId);
  if (!row?.extra)
    return;
  let previous;
  try {
    previous = JSON.parse(row.extra);
  } catch {
    return;
  }
  if (typeof extra.battery_percent !== "number" && typeof previous.battery_percent === "number") {
    extra.battery_percent = previous.battery_percent;
  }
  if (typeof extra.battery_charging !== "boolean" && typeof previous.battery_charging === "boolean") {
    extra.battery_charging = previous.battery_charging;
  }
  const previousDevice = previous.device && typeof previous.device === "object" && !Array.isArray(previous.device) ? previous.device : null;
  if (!previousDevice)
    return;
  const currentDevice = extra.device && typeof extra.device === "object" && !Array.isArray(extra.device) ? extra.device : {};
  extra.device = { ...previousDevice, ...currentDevice };
}

// packages/backend/src/routes/report.ts
async function handleReport(req) {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || Array.isArray(body) || body === null) {
    return Response.json({ error: "Invalid payload" }, { status: 400 });
  }
  const appId = typeof body.app_id === "string" ? body.app_id.trim() : "";
  const sleeping = body.extra && typeof body.extra === "object" && !Array.isArray(body.extra) ? body.extra.sleeping === true : false;
  if (!appId && !sleeping) {
    return Response.json({ error: "app_id required" }, { status: 400 });
  }
  try {
    processReportPayload(body, device);
  } catch (e) {
    console.error("[report] v1 handler error:", e.message);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
  return Response.json({ ok: true });
}

// packages/backend/src/routes/current.ts
init_db();

// packages/backend/src/services/visitors.ts
var TIMEOUT_MS = 30000;
var MAX_ENTRIES = 1e4;
var CLEANUP_INTERVAL_MS = 30000;
var BOT_PATTERNS = [
  "bot",
  "crawl",
  "spider",
  "slurp",
  "mediapartners",
  "facebookexternalhit",
  "linkedinbot",
  "twitterbot",
  "whatsapp",
  "telegrambot",
  "discordbot",
  "bingpreview",
  "yandex",
  "baidu",
  "sogou",
  "bytespider",
  "applebot",
  "amazonbot",
  "gptbot",
  "claudebot",
  "anthropic",
  "semrush",
  "ahref",
  "mj12bot",
  "dotbot",
  "petalbot",
  "dataforseo",
  "headlesschrome",
  "phantomjs",
  "puppeteer",
  "lighthouse",
  "pagespeed",
  "pingdom",
  "uptimerobot"
];
function isBot(ua) {
  if (!ua)
    return false;
  const lower = ua.toLowerCase();
  return BOT_PATTERNS.some((p) => lower.includes(p));
}

class VisitorTracker {
  seen = new Map;
  ipIndex = new Map;
  viewerIndex = new Map;
  lastCleanup = 0;
  constructor() {
    const timer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    timer.unref();
  }
  heartbeat(ip, userAgent, viewerId) {
    const cleanIp = normalizeClientIp(ip);
    if (userAgent && isBot(userAgent))
      return;
    const key = this.resolveIdentity(cleanIp, viewerId || "");
    if (!key)
      return;
    if (!this.seen.has(key) && this.seen.size >= MAX_ENTRIES) {
      this.cleanup();
      if (!this.seen.has(key) && this.seen.size >= MAX_ENTRIES)
        return;
    }
    const now = Date.now();
    const current = this.seen.get(key);
    const next = {
      lastSeen: now,
      viewerId: viewerId || current?.viewerId || "",
      ip: cleanIp || current?.ip || ""
    };
    this.seen.set(key, next);
    if (next.viewerId)
      this.viewerIndex.set(next.viewerId, key);
    if (next.ip)
      this.ipIndex.set(next.ip, key);
  }
  getCount() {
    this.cleanupThrottled();
    return this.seen.size;
  }
  cleanupThrottled() {
    const now = Date.now();
    if (now - this.lastCleanup >= 5000) {
      this.cleanup();
    }
  }
  resolveIdentity(ip, viewerId) {
    const viewerKey = viewerId ? this.viewerIndex.get(viewerId) || "" : "";
    const ipKey = ip ? this.ipIndex.get(ip) || "" : "";
    if (viewerKey && this.seen.has(viewerKey)) {
      if (ipKey && ipKey !== viewerKey)
        this.deleteKey(ipKey);
      return viewerKey;
    }
    if (ipKey && this.seen.has(ipKey)) {
      if (viewerId) {
        const entry = this.seen.get(ipKey);
        if (entry)
          entry.viewerId = viewerId;
        this.viewerIndex.set(viewerId, ipKey);
      }
      return ipKey;
    }
    if (viewerId) {
      const key = `viewer:${viewerId}`;
      this.viewerIndex.set(viewerId, key);
      if (ip)
        this.ipIndex.set(ip, key);
      return key;
    }
    if (ip) {
      const key = `ip:${ip}`;
      this.ipIndex.set(ip, key);
      return key;
    }
    return "";
  }
  deleteKey(key) {
    const entry = this.seen.get(key);
    if (!entry)
      return;
    this.seen.delete(key);
    if (entry.viewerId && this.viewerIndex.get(entry.viewerId) === key) {
      this.viewerIndex.delete(entry.viewerId);
    }
    if (entry.ip && this.ipIndex.get(entry.ip) === key) {
      this.ipIndex.delete(entry.ip);
    }
  }
  cleanup() {
    this.lastCleanup = Date.now();
    const cutoff = this.lastCleanup - TIMEOUT_MS;
    for (const [key, entry] of this.seen) {
      if (entry.lastSeen < cutoff) {
        this.deleteKey(key);
      }
    }
  }
}
var visitors = new VisitorTracker;
function normalizeClientIp(value) {
  const first = (value || "").split(",")[0]?.trim() || "";
  if (!first)
    return "";
  if (first.startsWith("[") && first.includes("]")) {
    return first.slice(1, first.indexOf("]"));
  }
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/.test(first))
    return first.slice(7);
  const portMatch = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(first);
  if (portMatch)
    return portMatch[1];
  return first;
}

// packages/backend/src/services/viewer-auth.ts
init_db();
import { randomBytes, createHash } from "crypto";
var TOKEN_TTL_SECONDS = 60 * 60;
var MIN_FINGERPRINT_LENGTH = 32;
var MIN_FINGERPRINT_UNIQUE = 6;
var POW_DIFFICULTY_HEX = 4;
var POW_CHALLENGE_TTL_MS = 5 * 60 * 1000;
var VIEWER_TOKEN_RATE_LIMIT = 600;
var MAX_POW_CHALLENGES = 1e4;
var VIEWER_IDENTITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
var MAX_VIEWER_IDENTITY_KEYS = 50000;
var powChallenges = new Map;
var issueRate = new Map;
var viewerTokenRate = new Map;
var powChallengeRate = new Map;
var fingerprintViewerIds = new Map;
var ipViewerIds = new Map;
var viewerAliases = new Map;
var fingerprintSeenAt = new Map;
var ipSeenAt = new Map;
var aliasSeenAt = new Map;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of powChallenges)
    if (now - v.createdAt > POW_CHALLENGE_TTL_MS)
      powChallenges.delete(k);
  for (const [k, v] of issueRate)
    if (v.resetAt < now)
      issueRate.delete(k);
  for (const [k, v] of viewerTokenRate)
    if (v.resetAt < now)
      viewerTokenRate.delete(k);
  for (const [k, v] of powChallengeRate)
    if (v.resetAt < now)
      powChallengeRate.delete(k);
  cleanupViewerIdentityMaps(now);
}, 300000).unref();
function base64url(input) {
  return Buffer.from(input, "utf8").toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function unbase64url(input) {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
function sign(payload) {
  const hex = hmacTitle(payload);
  return Buffer.from(hex, "hex").toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function cleanFingerprint(value) {
  if (typeof value !== "string")
    return "";
  return value.replace(/[^a-zA-Z0-9:_.,| -]/g, "").trim().slice(0, 512);
}
function fingerprintId(fingerprint) {
  return `fp_${hmacTitle(fingerprint).slice(0, 32)}`;
}
function ipHash(ip) {
  return hmacTitle("ip:" + ip).slice(0, 16);
}
function cleanupViewerIdentityMaps(now) {
  cleanupLastSeenMap(fingerprintSeenAt, now, (key) => fingerprintViewerIds.delete(key));
  cleanupLastSeenMap(ipSeenAt, now, (key) => ipViewerIds.delete(key));
  cleanupLastSeenMap(aliasSeenAt, now, (key) => viewerAliases.delete(key));
}
function cleanupLastSeenMap(lastSeen, now, deleteValue) {
  for (const [key, seenAt] of lastSeen) {
    if (now - seenAt > VIEWER_IDENTITY_TTL_MS) {
      lastSeen.delete(key);
      deleteValue(key);
    }
  }
  if (lastSeen.size <= MAX_VIEWER_IDENTITY_KEYS)
    return;
  const toDrop = [...lastSeen.entries()].sort((a, b) => a[1] - b[1]).slice(0, lastSeen.size - MAX_VIEWER_IDENTITY_KEYS);
  for (const [key] of toDrop) {
    lastSeen.delete(key);
    deleteValue(key);
  }
}
function canonicalViewerId(viewerId) {
  let current = viewerId;
  const seen = new Set;
  while (viewerAliases.has(current) && !seen.has(current)) {
    seen.add(current);
    aliasSeenAt.set(current, Date.now());
    current = viewerAliases.get(current);
  }
  for (const item of seen) {
    viewerAliases.set(item, current);
    aliasSeenAt.set(item, Date.now());
  }
  return current;
}
function linkViewerIds(primary, secondary) {
  const a = canonicalViewerId(primary);
  const b = canonicalViewerId(secondary);
  if (a === b)
    return a;
  const canonical = a < b ? a : b;
  const alias = canonical === a ? b : a;
  viewerAliases.set(alias, canonical);
  aliasSeenAt.set(alias, Date.now());
  return canonical;
}
function resolveViewerId(fingerprint, ip) {
  const now = Date.now();
  const fpId = fingerprintId(fingerprint);
  const ih = ip && ip !== "unknown" ? ipHash(ip) : "";
  const fpViewer = fingerprintViewerIds.get(fpId);
  const ipViewer = ih ? ipViewerIds.get(ih) : undefined;
  let viewerId = fpViewer || ipViewer || fpId;
  if (fpViewer && ipViewer)
    viewerId = linkViewerIds(fpViewer, ipViewer);
  viewerId = canonicalViewerId(viewerId);
  fingerprintViewerIds.set(fpId, viewerId);
  fingerprintSeenAt.set(fpId, now);
  if (ih) {
    ipViewerIds.set(ih, viewerId);
    ipSeenAt.set(ih, now);
  }
  return { viewerId, ipHash: ih };
}
function isLocalIp(ip) {
  if (!ip)
    return false;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip.startsWith("192.168.") || ip.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}
function issueViewerToken(fingerprintValue, ip) {
  const fingerprint = cleanFingerprint(fingerprintValue);
  if (fingerprint.length < MIN_FINGERPRINT_LENGTH || new Set(fingerprint).size < MIN_FINGERPRINT_UNIQUE) {
    return { error: "fingerprint too weak", status: 400 };
  }
  const rateKey = ip;
  const now = Date.now();
  const current = issueRate.get(rateKey);
  if (current && current.resetAt > now && current.count >= 12) {
    return { error: "rate limited", status: 429 };
  }
  if (!current || current.resetAt <= now) {
    issueRate.set(rateKey, { count: 1, resetAt: now + 60000 });
  } else {
    current.count++;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const identity = resolveViewerId(fingerprint, ip);
  const payload = {
    sub: identity.viewerId,
    ip: identity.ipHash,
    iat: nowSec,
    exp: nowSec + TOKEN_TTL_SECONDS
  };
  const encoded = base64url(JSON.stringify(payload));
  const token = `${encoded}.${sign(encoded)}`;
  return { token, viewerId: payload.sub };
}
function viewerTokenRateLimit(viewerId) {
  const now = Date.now();
  const current = viewerTokenRate.get(viewerId);
  if (!current || current.resetAt <= now) {
    viewerTokenRate.set(viewerId, { count: 1, resetAt: now + 3600000 });
    return true;
  }
  if (current.count >= VIEWER_TOKEN_RATE_LIMIT)
    return false;
  current.count++;
  return true;
}
function powChallengeRateLimit(ip) {
  const now = Date.now();
  const current = powChallengeRate.get(ip);
  if (!current || current.resetAt <= now) {
    powChallengeRate.set(ip, { count: 1, resetAt: now + 60000 });
    return true;
  }
  if (current.count >= 30)
    return false;
  current.count++;
  return true;
}
function verifyViewerToken(token) {
  if (!token || !token.includes("."))
    return null;
  const [encoded, signature] = token.split(".", 2);
  if (!encoded || !signature || sign(encoded) !== signature)
    return null;
  try {
    const payload = JSON.parse(unbase64url(encoded));
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number")
      return null;
    if (payload.exp < Math.floor(Date.now() / 1000))
      return null;
    if (!/^fp_[a-f0-9]{32}$/.test(payload.sub))
      return null;
    const tokenIpHash = typeof payload.ip === "string" ? payload.ip : "";
    return { viewerId: canonicalViewerId(payload.sub), exp: payload.exp, ipHash: tokenIpHash };
  } catch {
    return null;
  }
}
function issuePowChallenge(ip) {
  if (!ip || ip === "unknown") {
    return { error: "Unable to determine client IP", status: 400 };
  }
  if (powChallenges.size >= MAX_POW_CHALLENGES) {
    const now = Date.now();
    for (const [key, val] of powChallenges) {
      if (now - val.createdAt > POW_CHALLENGE_TTL_MS)
        powChallenges.delete(key);
    }
    if (powChallenges.size >= MAX_POW_CHALLENGES) {
      return { error: "Too many pending challenges", status: 429 };
    }
  }
  const challenge = randomBytes(32).toString("hex");
  powChallenges.set(challenge, { ip, ipUpdated: false, createdAt: Date.now() });
  return { challenge, difficulty: POW_DIFFICULTY_HEX };
}
function verifyPowSolution(challenge, nonce, ip) {
  const entry = powChallenges.get(challenge);
  if (!entry)
    return false;
  if (Date.now() - entry.createdAt > POW_CHALLENGE_TTL_MS) {
    powChallenges.delete(challenge);
    return false;
  }
  if (entry.ip !== ip) {
    if (entry.ipUpdated)
      return false;
    entry.ipUpdated = true;
    entry.ip = ip;
  }
  const input = challenge + nonce;
  const hashHex = createHash("sha256").update(input).digest("hex");
  powChallenges.delete(challenge);
  return hashHex.startsWith("0".repeat(POW_DIFFICULTY_HEX));
}
function getTlsFingerprint(req) {
  return req.headers.get("x-ja3-fingerprint") || req.headers.get("x-ja4") || null;
}
function edgeViewerIdentity(req) {
  const verified = req.headers.get("x-edge-verified");
  if (verified !== "true")
    return null;
  const viewerId = req.headers.get("x-edge-viewer-id");
  const edgeSig = req.headers.get("x-edge-signature");
  if (!viewerId || !edgeSig)
    return null;
  if (!/^fp_[a-f0-9]{32}$/.test(viewerId))
    return null;
  const expectedSig = hmacTitle("edge:" + viewerId);
  if (edgeSig !== expectedSig)
    return null;
  return { viewerId, exp: Math.floor(Date.now() / 1000) + 3600, ipHash: "" };
}
function viewerTokenFromRequest(req) {
  const auth = req.headers.get("authorization");
  const match = auth?.match(/^Bearer\s+(.+)$/i);
  if (match?.[1])
    return match[1];
  const url = new URL(req.url);
  return url.searchParams.get("viewer_token");
}

// packages/backend/src/routes/current.ts
var CURRENT_SNAPSHOT_TTL_MS = 2000;
var ANON_CURRENT_WINDOW_MS = 60000;
var ANON_CURRENT_LIMIT = 240;
var MAX_ANON_CURRENT_KEYS = 20000;
var currentSnapshotCache = null;
var anonymousCurrentRate = new Map;
setInterval(() => {
  cleanupAnonymousCurrentRate(Date.now());
}, 300000).unref();
function preparePublicDevices(devices) {
  return devices.map(({ window_title, extra, ...rest }) => {
    let parsedExtra = {};
    try {
      parsedExtra = extra ? JSON.parse(extra) : {};
    } catch {}
    if (parsedExtra.foreground && typeof parsedExtra.foreground === "object" && !Array.isArray(parsedExtra.foreground)) {
      const foreground = { ...parsedExtra.foreground };
      delete foreground.title;
      parsedExtra = { ...parsedExtra, foreground };
    }
    return { ...rest, extra: parsedExtra };
  });
}
function stripWindowTitle(records) {
  return records.map(({ window_title, ...rest }) => rest);
}
function getSnapshot() {
  const now = Date.now();
  if (currentSnapshotCache && currentSnapshotCache.expiresAt > now) {
    return currentSnapshotCache;
  }
  currentSnapshotCache = {
    expiresAt: now + CURRENT_SNAPSHOT_TTL_MS,
    devices: preparePublicDevices(getAllDeviceStates.all()),
    recentActivities: stripWindowTitle(getRecentActivities.all())
  };
  return currentSnapshotCache;
}
function allowAnonymousCurrent(ip) {
  if (!ip)
    return true;
  const now = Date.now();
  const current = anonymousCurrentRate.get(ip);
  if (!current || current.resetAt <= now) {
    if (!current && anonymousCurrentRate.size >= MAX_ANON_CURRENT_KEYS) {
      cleanupAnonymousCurrentRate(now);
      if (anonymousCurrentRate.size >= MAX_ANON_CURRENT_KEYS)
        return false;
    }
    anonymousCurrentRate.set(ip, { count: 1, resetAt: now + ANON_CURRENT_WINDOW_MS });
    return true;
  }
  if (current.count >= ANON_CURRENT_LIMIT)
    return false;
  current.count += 1;
  return true;
}
function cleanupAnonymousCurrentRate(now) {
  for (const [ip, entry] of anonymousCurrentRate) {
    if (entry.resetAt < now)
      anonymousCurrentRate.delete(ip);
  }
}
function handleCurrent(req, clientIp, userAgent) {
  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
  if (!viewer && !allowAnonymousCurrent(clientIp)) {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  visitors.heartbeat(clientIp, userAgent, viewer?.viewerId);
  const snapshot = getSnapshot();
  return Response.json({
    devices: snapshot.devices,
    recent_activities: snapshot.recentActivities,
    server_time: new Date().toISOString(),
    viewer_count: visitors.getCount()
  });
}

// packages/backend/src/routes/timeline.ts
init_db();

// packages/backend/src/services/cdn.ts
var CDN_MODE = /^(1|true|yes)$/i.test(process.env.CDN_MODE || "");
function applyCacheTags(headers, tags) {
  if (tags.length > 0) {
    const joined = tags.join(",");
    headers.set("Cache-Tag", joined);
    headers.set("ESA-Cache-Tag", joined);
  }
}
function withCdnHeaders(response, tags, maxAgeSeconds) {
  const headers = new Headers(response.headers);
  applyCacheTags(headers, tags);
  headers.set("Cache-Control", `public, max-age=${maxAgeSeconds}, stale-while-revalidate=30`);
  headers.set("Expires", new Date(Date.now() + maxAgeSeconds * 1000).toUTCString());
  if (CDN_MODE) {
    headers.set("Cache-Control", `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}, stale-while-revalidate=30`);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
function noStore(response, tags = []) {
  const headers = new Headers(response.headers);
  applyCacheTags(headers, tags);
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0, s-maxage=0");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Surrogate-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
function currentHourWindow(date = new Date) {
  return date.toISOString().slice(0, 13).replace(/[-T:]/g, "");
}
function normalizeHourWindow(value) {
  if (!value || !/^\d{10}$/.test(value))
    return null;
  return value;
}
function windowMatchesDate(window, date) {
  return window.slice(0, 8) === date.replaceAll("-", "");
}
function hourWindowForOffset(date, tzOffsetMinutes) {
  const local = new Date(date.getTime() - tzOffsetMinutes * 60000);
  return `${local.getUTCFullYear()}${String(local.getUTCMonth() + 1).padStart(2, "0")}${String(local.getUTCDate()).padStart(2, "0")}${String(local.getUTCHours()).padStart(2, "0")}`;
}
function isLiveHourWindow(window, tzOffsetMinutes, now = new Date) {
  const current = hourWindowForOffset(now, tzOffsetMinutes);
  const previous = hourWindowForOffset(new Date(now.getTime() - 60 * 60000), tzOffsetMinutes);
  return window === current || window === previous;
}
function safeTimezoneOffset(value) {
  return Number.isFinite(value) && Math.abs(value) <= 840 ? value : 0;
}
function utcRangeForLocalDate(date, tzOffsetMinutes) {
  const parts = date.split("-").map((part) => parseInt(part, 10));
  const [year, month, day] = parts;
  if (!year || !month || !day)
    return null;
  if (!validUtcParts(year, month, day))
    return null;
  const startMs = Date.UTC(year, month - 1, day) + safeTimezoneOffset(tzOffsetMinutes) * 60000;
  const endMs = startMs + 24 * 60 * 60000;
  const start = new Date(startMs);
  const end = new Date(endMs);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
    return null;
  return { start: start.toISOString(), end: end.toISOString() };
}
function utcRangeForLocalHourWindow(window, tzOffsetMinutes) {
  const year = parseInt(window.slice(0, 4), 10);
  const month = parseInt(window.slice(4, 6), 10);
  const day = parseInt(window.slice(6, 8), 10);
  const hour = parseInt(window.slice(8, 10), 10);
  if (!year || !month || !day || !Number.isInteger(hour) || hour < 0 || hour > 23)
    return null;
  if (!validUtcParts(year, month, day, hour))
    return null;
  const startMs = Date.UTC(year, month - 1, day, hour) + safeTimezoneOffset(tzOffsetMinutes) * 60000;
  const endMs = startMs + 60 * 60000;
  const start = new Date(startMs);
  const end = new Date(endMs);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
    return null;
  return { start: start.toISOString(), end: end.toISOString() };
}
function validUtcParts(year, month, day, hour = 0) {
  const probe = new Date(Date.UTC(year, month - 1, day, hour));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day && probe.getUTCHours() === hour;
}
function currentMessageSlot(date = new Date, slotMinutes = 10) {
  const safeSlot = Math.max(1, Math.min(60, Math.floor(slotMinutes)));
  const roundedMinute = Math.floor(date.getUTCMinutes() / safeSlot) * safeSlot;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(roundedMinute).padStart(2, "0");
  return `${year}${month}${day}${hour}${minute}`;
}

// packages/backend/src/routes/timeline.ts
var GAP_THRESHOLD_MS = 2 * 60 * 1000;
function handleTimeline(url) {
  const date = url.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "date parameter required (YYYY-MM-DD)" }, { status: 400 });
  }
  const tzParam = url.searchParams.get("tz");
  const tzOffsetMinutes = safeTimezoneOffset(tzParam ? parseInt(tzParam, 10) : 0);
  const deviceId = url.searchParams.get("device_id");
  const window = normalizeHourWindow(url.searchParams.get("window"));
  if (url.searchParams.has("window") && !window) {
    return Response.json({ error: "window must be YYYYMMDDHH" }, { status: 400 });
  }
  if (window && !windowMatchesDate(window, date)) {
    return Response.json({ error: "window does not match date" }, { status: 400 });
  }
  const range = window ? utcRangeForLocalHourWindow(window, tzOffsetMinutes) : utcRangeForLocalDate(date, tzOffsetMinutes);
  if (!range)
    return Response.json({ error: "Invalid date" }, { status: 400 });
  let activities = queryTimelineActivities(range, deviceId);
  if (window)
    activities = appendLookaheadActivities(activities);
  const segments = buildTimelineSegments(activities, { openLast: !window || isLiveHourWindow(window, tzOffsetMinutes) }).filter((segment) => !window || segmentHourWindow(segment, tzOffsetMinutes) === window);
  const summaryNested = new Map;
  for (const segment of segments) {
    let appMap = summaryNested.get(segment.device_id);
    if (!appMap) {
      appMap = new Map;
      summaryNested.set(segment.device_id, appMap);
    }
    appMap.set(segment.app_name, (appMap.get(segment.app_name) || 0) + segment.duration_minutes);
  }
  const summary = {};
  for (const [devId, appMap] of summaryNested) {
    summary[devId] = Object.fromEntries(appMap);
  }
  const response = Response.json({ date, window, segments, summary });
  const tags = ["timeline", `timeline-${date}`, ...window ? [`timeline-window-${window}`] : [], ...deviceId ? [`timeline-device-${deviceId}`] : []];
  if (window && isLiveHourWindow(window, tzOffsetMinutes) || !window && isTodayForOffset(date, tzOffsetMinutes)) {
    return noStore(response, tags);
  }
  return withCdnHeaders(response, tags, 60 * 60 * 24 * 30);
}
function queryTimelineActivities(range, deviceId) {
  const whereDevice = deviceId ? " AND device_id = ?" : "";
  const query = db.prepare(`
    SELECT *
    FROM activities
    WHERE started_at >= ? AND started_at < ?${whereDevice}
    ORDER BY started_at ASC
  `);
  return deviceId ? query.all(range.start, range.end, deviceId) : query.all(range.start, range.end);
}
function appendLookaheadActivities(activities) {
  if (activities.length === 0)
    return activities;
  const lastByDevice = new Map;
  for (const activity of activities) {
    const previous = lastByDevice.get(activity.device_id);
    if (!previous || new Date(activity.started_at).getTime() > new Date(previous.started_at).getTime()) {
      lastByDevice.set(activity.device_id, activity);
    }
  }
  const out = activities.slice();
  const seen = new Set(out.map((activity) => `${activity.device_id}|${activity.started_at}`));
  for (const last of lastByDevice.values()) {
    const next = queryNextActivity(last.device_id, last.started_at);
    if (!next)
      continue;
    const key = `${next.device_id}|${next.started_at}`;
    if (seen.has(key))
      continue;
    seen.add(key);
    out.push(next);
  }
  return out;
}
function queryNextActivity(deviceId, startedAt) {
  return db.prepare(`
    SELECT *
    FROM activities
    WHERE device_id = ? AND started_at > ?
    ORDER BY started_at ASC
    LIMIT 1
  `).get(deviceId, startedAt);
}
function segmentHourWindow(segment, tzOffsetMinutes) {
  const start = new Date(segment.started_at);
  if (Number.isNaN(start.getTime()))
    return null;
  return hourWindowForOffset(start, tzOffsetMinutes);
}
function buildTimelineSegments(activities, options = { openLast: true }) {
  const byDevice = new Map;
  for (const activity of activities) {
    const rows = byDevice.get(activity.device_id) || [];
    rows.push(activity);
    byDevice.set(activity.device_id, rows);
  }
  const segments = [];
  for (const rows of byDevice.values()) {
    rows.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
    for (let i = 0;i < rows.length; i += 1) {
      const activity = rows[i];
      const next = rows[i + 1];
      const startMs = new Date(activity.started_at).getTime();
      if (Number.isNaN(startMs))
        continue;
      let endedAt = next?.started_at ?? null;
      let endMs = endedAt ? new Date(endedAt).getTime() : startMs;
      if (Number.isNaN(endMs))
        endMs = startMs;
      if (endedAt && endMs - startMs > GAP_THRESHOLD_MS) {
        endMs = startMs + 60000;
        endedAt = new Date(endMs).toISOString();
      } else if (!endedAt && !options.openLast) {
        endMs = startMs + 60000;
        endedAt = new Date(endMs).toISOString();
      }
      const durationSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));
      segments.push({
        app_name: activity.app_name,
        app_id: activity.app_id,
        display_title: activity.display_title || "",
        started_at: activity.started_at,
        ended_at: next || !options.openLast ? endedAt : null,
        duration_seconds: durationSeconds,
        duration_minutes: Math.max(0, Math.round(durationSeconds / 60)),
        device_id: activity.device_id,
        device_name: activity.device_name
      });
    }
  }
  return segments.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
}
function isTodayForOffset(date, tzOffsetMinutes) {
  const now = new Date(Date.now() - safeTimezoneOffset(tzOffsetMinutes) * 60000);
  const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  return date === today;
}

// packages/backend/src/routes/health.ts
function handleHealth() {
  return withCdnHeaders(Response.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  }), ["health"], 5);
}

// packages/backend/src/routes/health-data.ts
init_db();
var MAX_RECORDS_PER_REQUEST = 1500;
var VALID_TYPES = new Set([
  "heart_rate",
  "resting_heart_rate",
  "heart_rate_variability",
  "steps",
  "distance",
  "exercise",
  "sleep",
  "oxygen_saturation",
  "body_temperature",
  "respiratory_rate",
  "blood_pressure",
  "blood_glucose",
  "weight",
  "height",
  "active_calories",
  "total_calories",
  "battery_percent",
  "wear_status",
  "sleep_status",
  "sleep_start",
  "sleep_end",
  "sleep_duration",
  "deep_sleep_duration",
  "sleep_score",
  "sleep_stage_count",
  "nap_start",
  "nap_end",
  "nap_duration",
  "stand_hours",
  "stand_count",
  "stand_target",
  "stress",
  "air_pressure",
  "altitude",
  "hydration",
  "nutrition"
]);
var insertHealthRecord = db.prepare(`
  INSERT INTO health_records (device_id, type, value, unit, recorded_at, end_time)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(device_id, type, recorded_at, end_time) DO NOTHING
`);
var insertMany = db.transaction((records) => {
  let inserted = 0;
  for (const r of records) {
    const result = insertHealthRecord.run(r.deviceId, r.type, r.value, r.unit, r.recordedAt, r.endTime);
    if (result.changes > 0)
      inserted++;
  }
  return inserted;
});
async function handleHealthData(req) {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.records) || body.records.length === 0) {
    return Response.json({ error: "records array required" }, { status: 400 });
  }
  if (body.records.length > MAX_RECORDS_PER_REQUEST) {
    return Response.json({ error: `Too many records (max ${MAX_RECORDS_PER_REQUEST})` }, { status: 400 });
  }
  const toInsert = [];
  for (const record of body.records) {
    if (typeof record.type !== "string" || !VALID_TYPES.has(record.type))
      continue;
    if (typeof record.value !== "number" || !Number.isFinite(record.value))
      continue;
    if (typeof record.unit !== "string" || record.unit.length > 20)
      continue;
    if (typeof record.timestamp !== "string" || !record.timestamp)
      continue;
    const ts = new Date(record.timestamp);
    if (isNaN(ts.getTime()))
      continue;
    let endTime = "";
    if (typeof record.end_time === "string" && record.end_time) {
      const et = new Date(record.end_time);
      if (!isNaN(et.getTime())) {
        endTime = et.toISOString();
      }
    }
    toInsert.push({
      deviceId: device.device_id,
      type: record.type,
      value: record.value,
      unit: record.unit.slice(0, 20),
      recordedAt: ts.toISOString(),
      endTime
    });
  }
  if (toInsert.length === 0) {
    return Response.json({ ok: true, inserted: 0 });
  }
  try {
    const inserted = insertMany(toInsert);
    return Response.json({ ok: true, inserted });
  } catch (e) {
    console.error("[health-data] DB error:", e.message);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
function handleHealthDataQuery(url, req) {
  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
  if (!viewer)
    return Response.json({ error: "Viewer token required" }, { status: 403 });
  if (!viewerTokenRateLimit(viewer.viewerId)) {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const date = url.searchParams.get("date");
  const deviceId = url.searchParams.get("device_id");
  const window = normalizeHourWindow(url.searchParams.get("window"));
  const summary = isSummaryRequest(url);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "date parameter required (YYYY-MM-DD)" }, { status: 400 });
  }
  if (url.searchParams.has("window") && !window) {
    return Response.json({ error: "window must be YYYYMMDDHH" }, { status: 400 });
  }
  if (window && !windowMatchesDate(window, date)) {
    return Response.json({ error: "window does not match date" }, { status: 400 });
  }
  const tzParam = url.searchParams.get("tz");
  const tzOffsetMinutes = safeTimezoneOffset(tzParam ? parseInt(tzParam, 10) : 0);
  try {
    const range = window ? utcRangeForLocalHourWindow(window, tzOffsetMinutes) : utcRangeForLocalDate(date, tzOffsetMinutes);
    if (!range)
      return Response.json({ error: "Invalid date" }, { status: 400 });
    const whereDevice = deviceId ? " AND device_id = ?" : "";
    const where = `recorded_at >= ? AND recorded_at < ?${whereDevice}`;
    const params = deviceId ? [range.start, range.end, deviceId] : [range.start, range.end];
    const records = db.prepare(healthSelectSql(where, summary)).all(...params);
    return healthQueryResponse(date, window, deviceId, records, tzOffsetMinutes, summary);
  } catch (e) {
    console.error("[health-data] Query error:", e.message);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
function healthQueryResponse(date, window, deviceId, records, tzOffsetMinutes, summary) {
  const response = Response.json({ date, window, summary, records });
  const tags = [
    "health-data",
    summary ? "health-data-summary" : "health-data-full",
    `health-data-${date}`,
    ...window ? [`health-data-window-${window}`] : [],
    ...deviceId ? [`health-device-${deviceId}`] : []
  ];
  if (window && isLiveHourWindow(window, tzOffsetMinutes) || !window && isTodayForOffset2(date, tzOffsetMinutes)) {
    return noStore(response, tags);
  }
  return withCdnHeaders(response, tags, 60 * 60 * 24 * 30);
}
function healthSelectSql(where, summary) {
  const fields = "device_id, type, value, unit, recorded_at, end_time";
  if (!summary) {
    return `
      SELECT ${fields}
      FROM health_records
      WHERE ${where}
      ORDER BY recorded_at ASC
    `;
  }
  return `
    SELECT ${fields}
    FROM (
      SELECT ${fields},
        ROW_NUMBER() OVER (
          PARTITION BY device_id, type
          ORDER BY recorded_at DESC, end_time DESC
        ) AS rn
      FROM health_records
      WHERE ${where}
    )
    WHERE rn = 1
    ORDER BY recorded_at ASC
  `;
}
function isSummaryRequest(url) {
  const value = url.searchParams.get("summary");
  return value === "1" || value === "true";
}
function isTodayForOffset2(date, tzOffsetMinutes) {
  const now = new Date(Date.now() - safeTimezoneOffset(tzOffsetMinutes) * 60000);
  const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  return date === today;
}

// packages/backend/src/routes/health-webhook.ts
init_db();
var MAX_RECORDS = 2000;
var insertHealthRecord2 = db.prepare(`
  INSERT INTO health_records (device_id, type, value, unit, recorded_at, end_time)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(device_id, type, recorded_at, end_time) DO NOTHING
`);
var insertMany2 = db.transaction((records) => {
  let inserted = 0;
  for (const r of records) {
    const result = insertHealthRecord2.run(r.deviceId, r.type, r.value, r.unit, r.recordedAt, r.endTime);
    if (result.changes > 0)
      inserted++;
  }
  return inserted;
});
function parseTime(raw) {
  if (typeof raw !== "string" || !raw)
    return null;
  const d = new Date(raw);
  if (isNaN(d.getTime()))
    return null;
  return d.toISOString();
}
async function handleHealthWebhook(req) {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "Invalid payload" }, { status: 400 });
  }
  const records = [];
  const deviceId = device.device_id;
  function isObj(v) {
    return typeof v === "object" && v !== null;
  }
  function add(type, value, unit, recordedAt, endTime) {
    if (records.length >= MAX_RECORDS)
      return false;
    if (!recordedAt)
      return true;
    if (typeof value !== "number" || !Number.isFinite(value))
      return true;
    records.push({ deviceId, type, value, unit, recordedAt, endTime: endTime || "" });
    return true;
  }
  if (Array.isArray(body.heart_rate)) {
    for (const item of body.heart_rate) {
      if (!isObj(item))
        continue;
      if (!add("heart_rate", item.bpm, "bpm", parseTime(item.time)))
        break;
    }
  }
  if (Array.isArray(body.steps)) {
    for (const item of body.steps) {
      if (!isObj(item))
        continue;
      if (!add("steps", item.count, "count", parseTime(item.start_time), parseTime(item.end_time)))
        break;
    }
  }
  if (Array.isArray(body.oxygen_saturation)) {
    for (const item of body.oxygen_saturation) {
      if (!isObj(item))
        continue;
      if (!add("oxygen_saturation", item.percentage, "%", parseTime(item.time)))
        break;
    }
  }
  if (Array.isArray(body.active_calories)) {
    for (const item of body.active_calories) {
      if (!isObj(item))
        continue;
      if (!add("active_calories", item.calories, "kcal", parseTime(item.start_time), parseTime(item.end_time)))
        break;
    }
  }
  if (Array.isArray(body.total_calories)) {
    for (const item of body.total_calories) {
      if (!isObj(item))
        continue;
      if (!add("total_calories", item.calories, "kcal", parseTime(item.start_time), parseTime(item.end_time)))
        break;
    }
  }
  if (Array.isArray(body.sleep)) {
    for (const item of body.sleep) {
      if (!isObj(item))
        continue;
      const val = item.duration_minutes ?? item.minutes;
      if (!add("sleep", val, "min", parseTime(item.start_time), parseTime(item.end_time)))
        break;
    }
  }
  if (Array.isArray(body.weight)) {
    for (const item of body.weight) {
      if (!isObj(item))
        continue;
      const val = item.weight ?? item.kg;
      if (!add("weight", val, "kg", parseTime(item.time)))
        break;
    }
  }
  if (Array.isArray(body.blood_pressure)) {
    for (const item of body.blood_pressure) {
      if (!isObj(item))
        continue;
      if (!add("blood_pressure", item.systolic, "mmHg", parseTime(item.time)))
        break;
    }
  }
  if (Array.isArray(body.blood_glucose)) {
    for (const item of body.blood_glucose) {
      if (!isObj(item))
        continue;
      const val = item.level ?? item.mmol_l;
      if (!add("blood_glucose", val, "mmol/L", parseTime(item.time)))
        break;
    }
  }
  if (Array.isArray(body.body_temperature)) {
    for (const item of body.body_temperature) {
      if (!isObj(item))
        continue;
      const val = item.temperature ?? item.celsius;
      if (!add("body_temperature", val, "\xB0C", parseTime(item.time)))
        break;
    }
  }
  if (Array.isArray(body.respiratory_rate)) {
    for (const item of body.respiratory_rate) {
      if (!isObj(item))
        continue;
      const val = item.rate ?? item.breaths_per_minute;
      if (!add("respiratory_rate", val, "bpm", parseTime(item.time)))
        break;
    }
  }
  if (Array.isArray(body.distance)) {
    for (const item of body.distance) {
      if (!isObj(item))
        continue;
      const val = item.distance ?? item.meters;
      if (!add("distance", val, "m", parseTime(item.start_time), parseTime(item.end_time)))
        break;
    }
  }
  if (Array.isArray(body.exercise)) {
    for (const item of body.exercise) {
      if (!isObj(item))
        continue;
      const val = item.duration_minutes ?? item.minutes;
      if (!add("exercise", val, "min", parseTime(item.start_time), parseTime(item.end_time)))
        break;
    }
  }
  if (Array.isArray(body.hydration)) {
    for (const item of body.hydration) {
      if (!isObj(item))
        continue;
      const val = item.volume ?? item.ml;
      if (!add("hydration", val, "mL", parseTime(item.start_time), parseTime(item.end_time)))
        break;
    }
  }
  if (Array.isArray(body.heart_rate_variability)) {
    for (const item of body.heart_rate_variability) {
      if (!isObj(item))
        continue;
      const val = item.ms ?? item.milliseconds;
      if (!add("heart_rate_variability", val, "ms", parseTime(item.time)))
        break;
    }
  }
  if (Array.isArray(body.resting_heart_rate)) {
    for (const item of body.resting_heart_rate) {
      if (!isObj(item))
        continue;
      if (!add("resting_heart_rate", item.bpm, "bpm", parseTime(item.time)))
        break;
    }
  }
  if (Array.isArray(body.height)) {
    for (const item of body.height) {
      if (!isObj(item))
        continue;
      const val = item.height ?? item.meters;
      if (!add("height", val, "m", parseTime(item.time)))
        break;
    }
  }
  if (records.length === 0) {
    return Response.json({ ok: true, inserted: 0, message: "No valid records found" });
  }
  try {
    const inserted = insertMany2(records);
    return Response.json({ ok: true, inserted, total_parsed: records.length });
  } catch (e) {
    console.error("[health-webhook] DB error:", e.message);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

// packages/backend/src/services/site-config.ts
var DISPLAY_NAME_PLACEHOLDER = "__LIVE_DASHBOARD_DISPLAY_NAME__";
var SITE_TITLE_PLACEHOLDER = "__LIVE_DASHBOARD_SITE_TITLE__";
var SITE_DESCRIPTION_PLACEHOLDER = "__LIVE_DASHBOARD_SITE_DESCRIPTION__";
var SITE_FAVICON_PLACEHOLDER = "/__LIVE_DASHBOARD_SITE_FAVICON__";
var DEFAULT_DISPLAY_NAME = "Monika";
var DEFAULT_FAVICON = "/icon.svg";
var SCRIPT_TAG_PATTERN = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
function nonEmpty(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
function isValidFaviconUrl(url) {
  if (url.startsWith("/") && !url.startsWith("//"))
    return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}
function normalizeFaviconUrl(url) {
  return url.trim() === "/favicon.ico" ? DEFAULT_FAVICON : url;
}
function getSiteConfig() {
  const displayName = nonEmpty(process.env.DISPLAY_NAME) ?? DEFAULT_DISPLAY_NAME;
  const siteTitle = nonEmpty(process.env.SITE_TITLE) ?? `${displayName} Now`;
  const siteDescription = nonEmpty(process.env.SITE_DESC) ?? `What is ${displayName} doing right now?`;
  const rawFavicon = nonEmpty(process.env.SITE_FAVICON) ?? DEFAULT_FAVICON;
  return {
    displayName,
    siteTitle,
    siteDescription,
    siteFavicon: isValidFaviconUrl(rawFavicon) ? normalizeFaviconUrl(rawFavicon) : DEFAULT_FAVICON,
    messageBoardEnabled: process.env.MESSAGE_BOARD_ENABLED !== "false",
    privateChatEnabled: process.env.PRIVATE_CHAT_ENABLED !== "false",
    nsfwFilterEnabled: process.env.NSFW_FILTER_DISABLED !== "true"
  };
}
function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function escapeJsString(value) {
  return JSON.stringify(value).slice(1, -1).replaceAll("<", "\\u003C").replaceAll(">", "\\u003E").replaceAll("&", "\\u0026");
}
function replacePlaceholders(input, config, escapeValue) {
  return input.replaceAll(DISPLAY_NAME_PLACEHOLDER, escapeValue(config.displayName)).replaceAll(SITE_TITLE_PLACEHOLDER, escapeValue(config.siteTitle)).replaceAll(SITE_DESCRIPTION_PLACEHOLDER, escapeValue(config.siteDescription)).replaceAll(SITE_FAVICON_PLACEHOLDER, escapeValue(config.siteFavicon));
}
function injectSiteConfig(html) {
  const config = getSiteConfig();
  let result = "";
  let lastIndex = 0;
  for (const match of html.matchAll(SCRIPT_TAG_PATTERN)) {
    const index = match.index ?? 0;
    const script = match[0];
    result += replacePlaceholders(html.slice(lastIndex, index), config, escapeHtml);
    result += replacePlaceholders(script, config, escapeJsString);
    lastIndex = index + script.length;
  }
  result += replacePlaceholders(html.slice(lastIndex), config, escapeHtml);
  return result;
}

// packages/backend/src/routes/config.ts
function handleConfig() {
  return withCdnHeaders(Response.json(getSiteConfig()), ["config"], 60);
}

// packages/backend/src/routes/daily-summary.ts
init_db();
function handleDailySummary(url) {
  const date = url.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "Missing or invalid date param (YYYY-MM-DD)" }, { status: 400 });
  }
  const row = getDailySummary.get(date);
  if (!row) {
    return withCdnHeaders(Response.json({ date, summary: null, generated_at: null }), ["daily-summary", `daily-summary-${date}`], 60);
  }
  return withCdnHeaders(Response.json(row), ["daily-summary", `daily-summary-${date}`], 60);
}

// packages/backend/src/routes/location.ts
init_db();
function handleLocationQuery(url, req) {
  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
  if (!viewer)
    return Response.json({ error: "Viewer token required" }, { status: 403 });
  if (!viewerTokenRateLimit(viewer.viewerId)) {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const date = url.searchParams.get("date");
  const deviceId = url.searchParams.get("device_id");
  const window = normalizeHourWindow(url.searchParams.get("window"));
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "date parameter required (YYYY-MM-DD)" }, { status: 400 });
  }
  if (url.searchParams.has("window") && !window) {
    return Response.json({ error: "window must be YYYYMMDDHH" }, { status: 400 });
  }
  if (window && !windowMatchesDate(window, date)) {
    return Response.json({ error: "window does not match date" }, { status: 400 });
  }
  try {
    const tzOffsetMinutes = timezoneOffsetMinutes(url);
    const range = window ? utcRangeForLocalHourWindow(window, tzOffsetMinutes) : utcRangeForLocalDate(date, tzOffsetMinutes);
    if (!range)
      return Response.json({ error: "Invalid date" }, { status: 400 });
    const whereDevice = deviceId ? " AND device_id = ?" : "";
    const query = db.prepare(`
      SELECT device_id, latitude, longitude, accuracy_m, provider, recorded_at
      FROM location_records
      WHERE recorded_at >= ? AND recorded_at < ?${whereDevice}
      ORDER BY recorded_at ASC
    `);
    const records = deviceId ? query.all(range.start, range.end, deviceId) : query.all(range.start, range.end);
    return locationQueryResponse(date, window, deviceId, records, tzOffsetMinutes);
  } catch (e) {
    console.error("[location] Query error:", e.message);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
function locationQueryResponse(date, window, deviceId, records, tzOffsetMinutes) {
  const response = Response.json({ date, window, records });
  const tags = ["location", `location-${date}`, ...window ? [`location-window-${window}`] : [], ...deviceId ? [`location-device-${deviceId}`] : []];
  if (window && isLiveHourWindow(window, tzOffsetMinutes) || !window && isTodayForOffset3(date, tzOffsetMinutes)) {
    return noStore(response, tags);
  }
  return withCdnHeaders(response, tags, 60 * 60 * 24 * 30);
}
function timezoneOffsetMinutes(url) {
  const tzParam = url.searchParams.get("tz");
  const value = tzParam ? parseInt(tzParam, 10) : 0;
  return safeTimezoneOffset(value);
}
function isTodayForOffset3(date, tzOffsetMinutes) {
  const now = new Date(Date.now() - tzOffsetMinutes * 60000);
  const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  return date === today;
}

// packages/backend/src/routes/viewer-token.ts
var POW_DISABLED = /^(1|true|yes)$/i.test(process.env.POW_DISABLED || "");
var TLS_CHECK_DISABLED = /^(1|true|yes)$/i.test(process.env.TLS_CHECK_DISABLED || "");
function handlePowChallenge(req, ipHint) {
  if (req.headers.get("x-edge-verified") === "true") {
    return Response.json({ skip: true, message: "Edge mode \u2014 PoW handled at edge" });
  }
  if (!ipHint || ipHint === "unknown" || isLocalIp(ipHint)) {
    return Response.json({ skip: true, message: "Local IP \u2014 PoW not required" });
  }
  const result = issuePowChallenge(ipHint);
  if ("error" in result) {
    return noStore(Response.json({ skip: true, message: result.error }));
  }
  return noStore(Response.json({ challenge: result.challenge, difficulty: result.difficulty, expiresIn: 300 }));
}
async function handleViewerTokenIssue(req, ipHint) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const tlsFp = getTlsFingerprint(req);
  const ipKnown2 = ipHint && ipHint !== "unknown";
  if (!TLS_CHECK_DISABLED && ipKnown2 && !isLocalIp(ipHint) && tlsFp) {
    const knownBotFps = ["", "no-tls"];
    if (knownBotFps.includes(tlsFp.toLowerCase())) {
      return Response.json({ error: "Suspicious TLS fingerprint" }, { status: 403 });
    }
  }
  const ipKnown = ipHint && ipHint !== "unknown";
  const edgeVerified = req.headers.get("x-edge-verified") === "true";
  if (!POW_DISABLED && ipKnown && !isLocalIp(ipHint) && !edgeVerified) {
    const { pow_challenge, pow_nonce } = body;
    if (!pow_challenge || !pow_nonce) {
      return Response.json({ error: "PoW challenge and nonce required", code: "POW_REQUIRED" }, { status: 403 });
    }
    const powValid = await verifyPowSolution(pow_challenge, pow_nonce, ipHint);
    if (!powValid) {
      return Response.json({ error: "Invalid PoW solution", code: "POW_INVALID" }, { status: 403 });
    }
  }
  const issued = issueViewerToken(body.fingerprint, ipHint);
  if (!issued.token) {
    return Response.json({ error: issued.error || "token issue failed" }, { status: issued.status || 400 });
  }
  return noStore(Response.json({
    token: issued.token,
    viewer_id: issued.viewerId,
    expires_in: 3600
  }));
}

// packages/backend/src/services/realtime.ts
init_db();
var MAX_TEXT_LENGTH = 500;
var MAX_MESSAGE_JSON_BYTES = 4096;
var MESSAGE_TTL_MINUTES = 30;
var VIEWER_RATE_LIMIT = 10;
var VIEWER_API_RATE_LIMIT = 60;
var VIEWER_WS_RATE_LIMIT = 30;
var RATE_WINDOW_MS = 60000;
var PING_INTERVAL_MS = 25000;
var PONG_TIMEOUT_MS = 35000;
var MAX_VIEWER_SOCKETS_PER_VIEWER = 4;
var MAX_VIEWER_SOCKETS_TOTAL = 1000;
var GLOBAL_IP_RATE_LIMIT = 120;
var MAX_GLOBAL_IP_RATE_KEYS = 20000;
var deviceSockets = new Map;
var viewerSockets = new Map;
var devicePongTimes = new Map;
var viewerRate = new Map;
var viewerApiRate = new Map;
var viewerWsRate = new Map;
var globalIpRate = new Map;
function globalIpRateLimit(ip) {
  const now = Date.now();
  const current = globalIpRate.get(ip);
  if (!current || current.resetAt <= now) {
    if (!current && globalIpRate.size >= MAX_GLOBAL_IP_RATE_KEYS) {
      cleanupGlobalIpRate(now);
      if (globalIpRate.size >= MAX_GLOBAL_IP_RATE_KEYS)
        return false;
    }
    globalIpRate.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (current.count >= GLOBAL_IP_RATE_LIMIT)
    return false;
  current.count++;
  return true;
}
function cleanupGlobalIpRate(now) {
  for (const [key, val] of globalIpRate) {
    if (val.resetAt < now)
      globalIpRate.delete(key);
  }
}
var markDeviceOffline = db.prepare(`
  UPDATE device_states SET is_online = 0
  WHERE device_id = ? AND is_online = 1
`);
var pingTimer = setInterval(() => {
  const now = Date.now();
  for (const [deviceId, ws] of deviceSockets) {
    const lastPong = devicePongTimes.get(deviceId) ?? 0;
    if (now - lastPong > PONG_TIMEOUT_MS) {
      ws.close(4001, "pong timeout");
      continue;
    }
    try {
      ws.ping();
    } catch {}
  }
}, PING_INTERVAL_MS);
pingTimer.unref();
var rateCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, val] of viewerRate) {
    if (val.resetAt < now)
      viewerRate.delete(key);
  }
  for (const [key, val] of viewerApiRate) {
    if (val.resetAt < now)
      viewerApiRate.delete(key);
  }
  for (const [key, val] of viewerWsRate) {
    if (val.resetAt < now)
      viewerWsRate.delete(key);
  }
  cleanupGlobalIpRate(now);
}, 300000);
rateCleanupTimer.unref();
var insertQueuedMessage = db.prepare(`
  INSERT INTO device_messages (id, device_id, viewer_id, text, expires_at)
  VALUES (?, ?, ?, ?, datetime('now', ?))
`);
var getPendingMessages = db.prepare(`
  SELECT dm.id, dm.viewer_id, dm.text, dm.created_at,
    COALESCE(vm.viewer_name, '') AS viewer_name,
    COALESCE(vm.kind, 'private') AS kind
  FROM device_messages dm
  LEFT JOIN visitor_messages vm ON vm.id = dm.id
  WHERE dm.device_id = ?
    AND dm.delivered_at = ''
    AND datetime(dm.expires_at) >= datetime('now')
  ORDER BY dm.created_at ASC
  LIMIT 20
`);
var markMessageDelivered = db.prepare(`
  UPDATE device_messages
  SET delivered_at = datetime('now')
  WHERE id = ? AND device_id = ?
`);
var markMessagesDelivered = db.transaction((deviceId, ids) => {
  for (const id of ids)
    markMessageDelivered.run(id, deviceId);
});
var markMessageReplied = db.prepare(`
  UPDATE device_messages
  SET replied_at = datetime('now')
  WHERE id = ?
`);
var isViewerBlockedStmt = db.prepare(`
  SELECT 1
  FROM blocked_viewers
  WHERE device_id = ? AND viewer_id = ?
  LIMIT 1
`);
var blockViewerStmt = db.prepare(`
  INSERT INTO blocked_viewers (device_id, viewer_id)
  VALUES (?, ?)
  ON CONFLICT(device_id, viewer_id) DO UPDATE SET blocked_at = datetime('now')
`);
var unblockViewerStmt = db.prepare(`
  DELETE FROM blocked_viewers
  WHERE device_id = ? AND viewer_id = ?
`);
var insertVisitorMessage = db.prepare(`
  INSERT INTO visitor_messages (id, device_id, viewer_id, viewer_name, kind, direction, text, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`);
var deleteVisitorMessage = db.prepare(`
  DELETE FROM visitor_messages
  WHERE id = ? AND device_id = ?
`);
var deleteVisitorMessagesByViewer = db.prepare(`
  DELETE FROM visitor_messages
  WHERE device_id = ? AND viewer_id = ?
`);
var upsertViewerRemark = db.prepare(`
  INSERT INTO viewer_remarks (device_id, viewer_id, remark)
  VALUES (?, ?, ?)
  ON CONFLICT(device_id, viewer_id) DO UPDATE SET
    remark = excluded.remark,
    updated_at = datetime('now')
`);
var getDeviceMessageHistory = db.prepare(`
  SELECT m.id, m.device_id, m.viewer_id, m.viewer_name, m.kind, m.direction, m.text, m.created_at,
         COALESCE(r.remark, '') as viewer_remark
  FROM visitor_messages m
  LEFT JOIN viewer_remarks r ON m.device_id = r.device_id AND m.viewer_id = r.viewer_id
  WHERE (m.device_id = ? OR (m.device_id = '__public__' AND m.kind = 'public'))
    AND (? = '' OR datetime(m.created_at) > datetime(?))
  ORDER BY m.created_at ASC
  LIMIT 500
`);
var getPublicMessagesByWindow = db.prepare(`
  SELECT id, device_id, viewer_id, viewer_name, text, created_at
  FROM visitor_messages
  WHERE kind = 'public'
    AND created_at >= ?
    AND created_at < ?
  ORDER BY created_at ASC
  LIMIT 200
`);
var getMessageTargetDevices = db.prepare(`
  SELECT device_id
  FROM device_states
  WHERE platform <> 'zepp'
  ORDER BY last_seen_at DESC
  LIMIT 20
`);
function send(ws, payload) {
  ws.send(JSON.stringify(payload));
}
function addViewerSocket(viewerId, ws) {
  const sockets = viewerSockets.get(viewerId) ?? new Set;
  if (sockets.size >= MAX_VIEWER_SOCKETS_PER_VIEWER) {
    const oldest = sockets.values().next().value;
    if (oldest) {
      sockets.delete(oldest);
      try {
        oldest.close(1013, "viewer socket limit");
      } catch {}
    }
  }
  sockets.add(ws);
  viewerSockets.set(viewerId, sockets);
}
function removeViewerSocket(viewerId, ws) {
  const sockets = viewerSockets.get(viewerId);
  if (!sockets)
    return;
  sockets.delete(ws);
  if (sockets.size === 0) {
    viewerSockets.delete(viewerId);
  }
}
function forEachViewerSocket(callback) {
  for (const sockets of viewerSockets.values()) {
    for (const viewerWs of sockets)
      callback(viewerWs);
  }
}
function sendToViewerSockets(viewerId, payload) {
  const sockets = viewerSockets.get(viewerId);
  if (!sockets || sockets.size === 0)
    return 0;
  let delivered = 0;
  const encoded = JSON.stringify(payload);
  for (const viewerWs of sockets) {
    try {
      viewerWs.send(encoded);
      delivered += 1;
    } catch {}
  }
  return delivered;
}
function viewerSocketCount() {
  let count = 0;
  for (const sockets of viewerSockets.values())
    count += sockets.size;
  return count;
}
function requestIp(req) {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip") || req.headers.get("cf-connecting-ip") || "unknown";
}
function parseJson(raw) {
  try {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    if (text.length > MAX_MESSAGE_JSON_BYTES)
      return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function cleanText(value) {
  if (typeof value !== "string")
    return "";
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g, "").trim().slice(0, MAX_TEXT_LENGTH);
}
function cleanMessageId(value) {
  if (typeof value !== "string")
    return "";
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return /^[a-zA-Z0-9_.:-]{1,80}$/.test(cleaned) ? cleaned : "";
}
async function readMessageJson(req) {
  const length = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > MAX_MESSAGE_JSON_BYTES) {
    return { ok: false, response: Response.json({ error: "Request too large" }, { status: 413 }) };
  }
  const contentType = req.headers.get("content-type") || "";
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    return { ok: false, response: Response.json({ error: "Content-Type must be application/json" }, { status: 415 }) };
  }
  let text = "";
  try {
    text = await readLimitedText(req, MAX_MESSAGE_JSON_BYTES);
  } catch {
    return { ok: false, response: Response.json({ error: "Request too large" }, { status: 413 }) };
  }
  if (text.length > MAX_MESSAGE_JSON_BYTES) {
    return { ok: false, response: Response.json({ error: "Request too large" }, { status: 413 }) };
  }
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: Response.json({ error: "Invalid JSON" }, { status: 400 }) };
  }
}
async function readLimitedText(req, maxBytes) {
  if (!req.body)
    return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder;
  let bytes = 0;
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done)
      break;
    if (!value)
      continue;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      try {
        await reader.cancel();
      } catch {}
      throw new Error("too_large");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}
function rateLimit(viewerId) {
  const now = Date.now();
  const current = viewerRate.get(viewerId);
  if (!current || current.resetAt <= now) {
    viewerRate.set(viewerId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (current.count >= VIEWER_RATE_LIMIT)
    return false;
  current.count += 1;
  return true;
}
function apiRateLimit(viewerId) {
  const now = Date.now();
  const current = viewerApiRate.get(viewerId);
  if (!current || current.resetAt <= now) {
    viewerApiRate.set(viewerId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (current.count >= VIEWER_API_RATE_LIMIT)
    return false;
  current.count += 1;
  return true;
}
function cleanViewerId(value) {
  if (typeof value !== "string")
    return "";
  return /^[a-zA-Z0-9_-]{3,120}$/.test(value) ? value : "";
}
function cleanDeviceId(value) {
  if (typeof value !== "string")
    return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
}
function isViewerBlocked(deviceId, viewerId) {
  return Boolean(isViewerBlockedStmt.get(deviceId, viewerId));
}
function cleanViewerName(value) {
  if (typeof value !== "string")
    return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32);
}
function cleanKind(value) {
  return value === "public" ? "public" : "private";
}
function recordMessage(id, deviceId, viewerId, viewerName, kind, direction, text, createdAt = new Date().toISOString()) {
  insertVisitorMessage.run(id, deviceId, viewerId, viewerName, kind, direction, text, createdAt);
}
function queueMessage(deviceId, viewerId, text, messageId) {
  try {
    insertQueuedMessage.run(messageId, deviceId, viewerId, text, `+${MESSAGE_TTL_MINUTES} minutes`);
  } catch {}
}
function wsRateLimit(viewerId) {
  const now = Date.now();
  const current = viewerWsRate.get(viewerId);
  if (!current || current.resetAt <= now) {
    viewerWsRate.set(viewerId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (current.count >= VIEWER_WS_RATE_LIMIT)
    return false;
  current.count += 1;
  return true;
}
function messageTargets(preferredDeviceId = "") {
  const ids = new Set;
  if (preferredDeviceId)
    ids.add(preferredDeviceId);
  for (const row of getMessageTargetDevices.all()) {
    if (row.device_id)
      ids.add(row.device_id);
  }
  for (const id of deviceSockets.keys())
    ids.add(id);
  return Array.from(ids).slice(0, 20);
}
function deliverViewerMessage(targetDeviceId, viewerId, viewerName, kind, text, messageId, createdAt) {
  const deviceWs = deviceSockets.get(targetDeviceId);
  if (deviceWs) {
    send(deviceWs, {
      type: "viewer_message",
      message_id: messageId,
      viewer_id: viewerId,
      viewer_name: viewerName,
      kind,
      text,
      created_at: createdAt
    });
    return "sent";
  }
  queueMessage(targetDeviceId, viewerId, text, messageId);
  return "queued";
}
function deliverQueuedMessages(deviceId, ws) {
  const rows = getPendingMessages.all(deviceId);
  if (rows.length === 0)
    return;
  markMessagesDelivered(deviceId, rows.map((r) => r.id));
  for (const row of rows) {
    send(ws, {
      type: "viewer_message",
      message_id: row.id,
      viewer_id: row.viewer_id,
      viewer_name: row.viewer_name,
      kind: row.kind,
      text: row.text,
      created_at: row.created_at,
      queued: true
    });
  }
}
function getWsInfo(req) {
  const url = new URL(req.url);
  const role = url.searchParams.get("role");
  if (role === "device") {
    const device = authenticateToken(req.headers.get("authorization"));
    if (!device)
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    return { role: "device", id: device.device_id, device };
  }
  if (role === "viewer") {
    const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
    if (!viewer)
      return Response.json({ error: "Viewer token required" }, { status: 403 });
    if (!globalIpRateLimit(requestIp(req))) {
      return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    }
    if (!wsRateLimit(viewer.viewerId)) {
      return Response.json({ error: "Too many WebSocket reconnects" }, { status: 429 });
    }
    if (viewerSocketCount() >= MAX_VIEWER_SOCKETS_TOTAL) {
      return Response.json({ error: "Too many WebSocket connections" }, { status: 503 });
    }
    return { role: "viewer", id: viewer.viewerId };
  }
  return Response.json({ error: "role must be viewer or device" }, { status: 400 });
}
var realtimeWebSocket = {
  open(ws) {
    if (ws.data.role === "device") {
      const previous = deviceSockets.get(ws.data.id);
      if (previous && previous !== ws) {
        try {
          previous.close(4000, "replaced by new device socket");
        } catch {}
      }
      deviceSockets.set(ws.data.id, ws);
      devicePongTimes.set(ws.data.id, Date.now());
      send(ws, { type: "ack", status: "connected", role: "device", device_id: ws.data.id });
      deliverQueuedMessages(ws.data.id, ws);
      return;
    }
    addViewerSocket(ws.data.id, ws);
    send(ws, { type: "ack", status: "connected", role: "viewer", viewer_id: ws.data.id });
  },
  pong(ws) {
    if (ws.data.role === "device") {
      devicePongTimes.set(ws.data.id, Date.now());
    }
  },
  message(ws, raw) {
    const data = parseJson(raw);
    if (!data || typeof data.type !== "string") {
      send(ws, { type: "error", error: "Invalid JSON" });
      return;
    }
    if (ws.data.role === "viewer" && data.type === "viewer_ping") {
      send(ws, { type: "viewer_pong", at: new Date().toISOString() });
      return;
    }
    if (ws.data.role === "viewer" && data.type === "viewer_message") {
      if (!rateLimit(ws.data.id)) {
        send(ws, { type: "error", error: "Rate limit exceeded" });
        return;
      }
      const targetDeviceId = cleanDeviceId(data.target_device_id);
      const text = cleanText(data.text);
      const kind = cleanKind(data.kind);
      const viewerName = cleanViewerName(data.viewer_name);
      const messageId = cleanMessageId(data.message_id) || crypto.randomUUID();
      if (!targetDeviceId || !text) {
        if (kind === "private") {
          send(ws, { type: "error", message_id: messageId, error: "target_device_id and text required" });
          return;
        }
        if (!text) {
          send(ws, { type: "error", message_id: messageId, error: "text required" });
          return;
        }
      }
      if (kind === "public") {
        const createdAt2 = new Date().toISOString();
        const targets = messageTargets(targetDeviceId).filter((deviceId) => !isViewerBlocked(deviceId, ws.data.id));
        recordMessage(messageId, "__public__", ws.data.id, viewerName, "public", "viewer", text, createdAt2);
        let sent = 0;
        let queued = 0;
        for (const deviceId of targets) {
          const status2 = deliverViewerMessage(deviceId, ws.data.id, viewerName, "public", text, messageId, createdAt2);
          if (status2 === "sent")
            sent += 1;
          else
            queued += 1;
        }
        send(ws, { type: "ack", message_id: messageId, status: sent > 0 ? "sent" : queued > 0 ? "queued" : "recorded", sent, queued });
        return;
      }
      if (isViewerBlocked(targetDeviceId, ws.data.id)) {
        send(ws, { type: "error", message_id: messageId, error: "blocked_by_device" });
        return;
      }
      const createdAt = new Date().toISOString();
      recordMessage(messageId, targetDeviceId, ws.data.id, viewerName, "private", "viewer", text, createdAt);
      const status = deliverViewerMessage(targetDeviceId, ws.data.id, viewerName, "private", text, messageId, createdAt);
      send(ws, { type: "ack", message_id: messageId, status });
      return;
    }
    if (ws.data.role === "device" && data.type === "device_reply") {
      const targetViewerId = typeof data.target_viewer_id === "string" ? data.target_viewer_id : "";
      const text = cleanText(data.text);
      const messageId = cleanMessageId(data.message_id);
      const replyId = cleanMessageId(data.reply_id) || crypto.randomUUID();
      if (!targetViewerId || !text) {
        send(ws, { type: "error", message_id: messageId, error: "target_viewer_id and text required" });
        return;
      }
      if (messageId)
        markMessageReplied.run(messageId);
      recordMessage(replyId, ws.data.id, targetViewerId, "", "reply", "device", text);
      sendToViewerSockets(targetViewerId, {
        type: "device_reply",
        message_id: replyId,
        in_reply_to: messageId,
        device_id: ws.data.id,
        text,
        created_at: new Date().toISOString()
      });
      send(ws, { type: "ack", message_id: messageId, status: "reply_sent" });
      return;
    }
    if (ws.data.role === "device" && data.type === "device_status") {
      devicePongTimes.set(ws.data.id, Date.now());
      if (data.payload && ws.data.device) {
        const receivedAt = new Date().toISOString();
        let publicPayload = null;
        try {
          publicPayload = processReportPayload(data.payload, ws.data.device);
        } catch (e) {
          console.error("[ws] device_status processing error:", e.message);
          send(ws, { type: "error", error: "status_processing_failed" });
          return;
        }
        if (publicPayload) {
          const deviceUpdate = {
            type: "device_update",
            device_id: ws.data.device.device_id,
            payload: publicPayload,
            timestamp: receivedAt
          };
          const updateMsg = JSON.stringify(deviceUpdate);
          forEachViewerSocket((viewerWs) => {
            try {
              viewerWs.send(updateMsg);
            } catch {}
          });
        }
      }
      send(ws, { type: "ack", status: "status_received" });
      return;
    }
    send(ws, { type: "error", error: "Unsupported message type" });
  },
  close(ws) {
    if (ws.data.role === "device") {
      if (deviceSockets.get(ws.data.id) === ws)
        deviceSockets.delete(ws.data.id);
      devicePongTimes.delete(ws.data.id);
      try {
        markDeviceOffline.run(ws.data.id);
      } catch {}
    } else {
      removeViewerSocket(ws.data.id, ws);
    }
  }
};
function handleDeviceMessages(req) {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const rows = getPendingMessages.all(device.device_id);
  if (rows.length > 0) {
    markMessagesDelivered(device.device_id, rows.map((r) => r.id));
  }
  return Response.json({ messages: rows });
}
function handleDeviceMessageHistory(req) {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const since = url.searchParams.get("since") || "";
  const safeSince = since && !isNaN(new Date(since).getTime()) ? new Date(since).toISOString() : "";
  const rows = getDeviceMessageHistory.all(device.device_id, safeSince, safeSince);
  return Response.json({ messages: rows });
}
async function handleDeviceMessageReply(req) {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = await readMessageJson(req);
  if (!parsed.ok)
    return parsed.response;
  const body = parsed.body;
  const viewerId = typeof body.target_viewer_id === "string" ? body.target_viewer_id : "";
  const messageId = cleanMessageId(body.message_id);
  const text = cleanText(body.text);
  if (!viewerId || !text) {
    return Response.json({ error: "target_viewer_id and text required" }, { status: 400 });
  }
  if (messageId)
    markMessageReplied.run(messageId);
  const replyId = cleanMessageId(body.reply_id) || crypto.randomUUID();
  recordMessage(replyId, device.device_id, viewerId, "", "reply", "device", text);
  const delivered = sendToViewerSockets(viewerId, {
    type: "device_reply",
    message_id: replyId,
    in_reply_to: messageId,
    device_id: device.device_id,
    text,
    created_at: new Date().toISOString()
  });
  return Response.json({ ok: true, delivered: delivered > 0, delivered_sockets: delivered });
}
async function handlePublicMessagePost(req) {
  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
  if (!viewer)
    return Response.json({ error: "Viewer token required" }, { status: 403 });
  if (!viewerTokenRateLimit(viewer.viewerId) || !apiRateLimit(viewer.viewerId)) {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const parsed = await readMessageJson(req);
  if (!parsed.ok)
    return parsed.response;
  const body = parsed.body;
  const text = cleanText(body.text);
  if (!text)
    return Response.json({ error: "text required" }, { status: 400 });
  const preferredDeviceId = cleanDeviceId(body.target_device_id);
  const viewerName = cleanViewerName(body.viewer_name);
  const messageId = cleanMessageId(body.message_id) || crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const targets = messageTargets(preferredDeviceId).filter((deviceId) => !isViewerBlocked(deviceId, viewer.viewerId));
  recordMessage(messageId, "__public__", viewer.viewerId, viewerName, "public", "viewer", text, createdAt);
  let sent = 0;
  let queued = 0;
  for (const deviceId of targets) {
    const status = deliverViewerMessage(deviceId, viewer.viewerId, viewerName, "public", text, messageId, createdAt);
    if (status === "sent")
      sent += 1;
    else
      queued += 1;
  }
  const payload = JSON.stringify({
    type: "public_message",
    message: {
      id: messageId,
      device_id: "__public__",
      viewer_id: viewer.viewerId,
      viewer_name: viewerName,
      text,
      created_at: createdAt
    }
  });
  forEachViewerSocket((viewerWs) => {
    try {
      viewerWs.send(payload);
    } catch {}
  });
  return Response.json({ ok: true, message_id: messageId, sent, queued });
}
async function handlePrivateMessagePost(req) {
  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
  if (!viewer)
    return Response.json({ error: "Viewer token required" }, { status: 403 });
  if (!viewerTokenRateLimit(viewer.viewerId) || !apiRateLimit(viewer.viewerId)) {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const parsed = await readMessageJson(req);
  if (!parsed.ok)
    return parsed.response;
  const body = parsed.body;
  const targetDeviceId = cleanDeviceId(body.target_device_id);
  const text = cleanText(body.text);
  const viewerName = cleanViewerName(body.viewer_name);
  const messageId = cleanMessageId(body.message_id) || crypto.randomUUID();
  if (!targetDeviceId || !text) {
    return Response.json({ error: "target_device_id and text required", message_id: messageId }, { status: 400 });
  }
  if (isViewerBlocked(targetDeviceId, viewer.viewerId)) {
    return Response.json({ error: "blocked_by_device", message_id: messageId }, { status: 403 });
  }
  const createdAt = new Date().toISOString();
  recordMessage(messageId, targetDeviceId, viewer.viewerId, viewerName, "private", "viewer", text, createdAt);
  const status = deliverViewerMessage(targetDeviceId, viewer.viewerId, viewerName, "private", text, messageId, createdAt);
  return Response.json({ ok: true, message_id: messageId, status });
}
function handlePublicMessages(req) {
  const viewer = edgeViewerIdentity(req) || verifyViewerToken(viewerTokenFromRequest(req));
  if (!viewer)
    return Response.json({ error: "Viewer token required" }, { status: 403 });
  if (!viewerTokenRateLimit(viewer.viewerId)) {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  if (!apiRateLimit(viewer.viewerId)) {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const url = new URL(req.url);
  const slotParam = url.searchParams.get("slot");
  if (slotParam) {
    if (!/^\d{12}$/.test(slotParam)) {
      return Response.json({ error: "slot must be YYYYMMDDHHmm" }, { status: 400 });
    }
    const year2 = Number(slotParam.slice(0, 4));
    const month2 = Number(slotParam.slice(4, 6)) - 1;
    const day2 = Number(slotParam.slice(6, 8));
    const hour2 = Number(slotParam.slice(8, 10));
    const minute = Number(slotParam.slice(10, 12));
    const start2 = new Date(Date.UTC(year2, month2, day2, hour2, minute));
    if (isNaN(start2.getTime()))
      return Response.json({ error: "invalid slot" }, { status: 400 });
    const end2 = new Date(start2.getTime() + 10 * 60000);
    const rows2 = getPublicMessagesByWindow.all(start2.toISOString(), end2.toISOString());
    const currentSlot = slotParam === currentMessageSlot();
    const response2 = Response.json({ slot: slotParam, messages: rows2 });
    if (currentSlot)
      return noStore(response2, ["public-messages", `public-messages-slot-${slotParam}`]);
    return withCdnHeaders(response2, ["public-messages", `public-messages-slot-${slotParam}`], 60 * 60 * 24 * 30);
  }
  const windowParam = url.searchParams.get("window") || currentHourWindow();
  if (!/^\d{10}$/.test(windowParam)) {
    return Response.json({ error: "window must be YYYYMMDDHH" }, { status: 400 });
  }
  const year = Number(windowParam.slice(0, 4));
  const month = Number(windowParam.slice(4, 6)) - 1;
  const day = Number(windowParam.slice(6, 8));
  const hour = Number(windowParam.slice(8, 10));
  const start = new Date(Date.UTC(year, month, day, hour));
  if (isNaN(start.getTime()))
    return Response.json({ error: "invalid window" }, { status: 400 });
  const end = new Date(start.getTime() + 60 * 60000);
  const rows = getPublicMessagesByWindow.all(start.toISOString(), end.toISOString());
  const currentWindow = windowParam === currentHourWindow();
  const response = Response.json({ window: windowParam, messages: rows });
  if (currentWindow)
    return noStore(response, ["public-messages", `public-messages-${windowParam}`]);
  return withCdnHeaders(response, ["public-messages", `public-messages-${windowParam}`], 60 * 60 * 24 * 30);
}
async function handleBlockViewer(req) {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = await readMessageJson(req);
  if (!parsed.ok)
    return parsed.response;
  const body = parsed.body;
  const viewerId = cleanViewerId(body.viewer_id);
  if (!viewerId) {
    return Response.json({ error: "viewer_id required" }, { status: 400 });
  }
  blockViewerStmt.run(device.device_id, viewerId);
  return Response.json({ ok: true });
}
async function handleUnblockViewer(req) {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = await readMessageJson(req);
  if (!parsed.ok)
    return parsed.response;
  const body = parsed.body;
  const viewerId = cleanViewerId(body.viewer_id);
  if (!viewerId) {
    return Response.json({ error: "viewer_id required" }, { status: 400 });
  }
  unblockViewerStmt.run(device.device_id, viewerId);
  return Response.json({ ok: true });
}
async function handleDeleteMessage(req) {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = await readMessageJson(req);
  if (!parsed.ok)
    return parsed.response;
  const body = parsed.body;
  const messageId = cleanMessageId(body.message_id);
  if (!messageId) {
    return Response.json({ error: "message_id required" }, { status: 400 });
  }
  deleteVisitorMessage.run(messageId, device.device_id);
  return Response.json({ ok: true });
}
async function handleDeleteViewerMessages(req) {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = await readMessageJson(req);
  if (!parsed.ok)
    return parsed.response;
  const body = parsed.body;
  const viewerId = cleanViewerId(body.viewer_id);
  if (!viewerId) {
    return Response.json({ error: "viewer_id required" }, { status: 400 });
  }
  deleteVisitorMessagesByViewer.run(device.device_id, viewerId);
  return Response.json({ ok: true });
}
async function handleSetRemark(req) {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = await readMessageJson(req);
  if (!parsed.ok)
    return parsed.response;
  const body = parsed.body;
  const viewerId = cleanViewerId(body.viewer_id);
  const remark = cleanText(body.remark);
  if (!viewerId) {
    return Response.json({ error: "viewer_id required" }, { status: 400 });
  }
  upsertViewerRemark.run(device.device_id, viewerId, remark);
  return Response.json({ ok: true });
}
async function handleDeleteDevice(req) {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { deleteDevice: deleteDevice2, deleteDeviceActivities: deleteDeviceActivities2 } = await Promise.resolve().then(() => (init_db(), exports_db));
  const ws = deviceSockets.get(device.device_id);
  if (ws) {
    try {
      ws.close(4003, "device_deleted");
    } catch {}
    deviceSockets.delete(device.device_id);
  }
  devicePongTimes.delete(device.device_id);
  deleteDeviceActivities2.run(device.device_id);
  deleteDevice2.run(device.device_id);
  return Response.json({ ok: true, deleted: device.device_id });
}

// packages/backend/src/services/cleanup.ts
init_db();

// packages/backend/src/services/daily-summary-gen.ts
init_db();
var AI_API_URL = process.env.AI_API_URL || "";
var AI_API_KEY = process.env.AI_API_KEY || "";
var AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini";
var SYSTEM_PROMPT = `\u4F60\u662F\u4E00\u4E2A\u7B80\u6D01\u6587\u827A\u7684\u65E5\u8BB0\u52A9\u624B\u3002\u6839\u636E\u7528\u6237\u4ECA\u5929\u5728\u5404\u8BBE\u5907\u4E0A\u7684\u5E94\u7528\u4F7F\u7528\u8BB0\u5F55\uFF0C\u5199\u4E00\u6BB550-80\u5B57\u7684\u4E2D\u6587\u65E5\u603B\u7ED3\u3002
\u8981\u6C42\uFF1A
- \u8BED\u6C14\u6E29\u6696\u3001\u81EA\u7136\uFF0C\u50CF\u670B\u53CB\u968F\u7B14
- \u63D0\u70BC\u8FD9\u4E00\u5929\u7684\u8282\u594F\u548C\u4E3B\u9898\uFF0C\u4E0D\u8981\u9010\u6761\u7F57\u5217
- \u4E0D\u8981\u4F7F\u7528 emoji
- \u4E0D\u8981\u8D85\u8FC780\u5B57`;
var getDailyActivityRows = db.prepare(`
  SELECT device_name, app_name, display_title, started_at
  FROM activities
  WHERE started_at >= ? AND started_at < ?
  ORDER BY started_at ASC
`);
function todayStr() {
  const d = new Date;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function buildUserPrompt(rows) {
  const byDevice = new Map;
  for (const r of rows) {
    let dev = byDevice.get(r.device_name);
    if (!dev) {
      dev = new Map;
      byDevice.set(r.device_name, dev);
    }
    let app = dev.get(r.app_name);
    if (!app) {
      app = { count: 0, titles: new Set };
      dev.set(r.app_name, app);
    }
    app.count++;
    if (r.display_title)
      app.titles.add(r.display_title);
  }
  const lines = [`\u65E5\u671F: ${todayStr()}`];
  for (const [dev, apps] of byDevice) {
    lines.push(`
[${dev}]`);
    const sorted = Array.from(apps.entries()).sort((a, b) => b[1].count - a[1].count);
    for (const [app, { count, titles }] of sorted.slice(0, 8)) {
      const t = titles.size ? ` (${Array.from(titles).slice(0, 3).join(", ")})` : "";
      lines.push(`  ${app}: ${count}\u6761\u8BB0\u5F55${t}`);
    }
  }
  return lines.join(`
`);
}
async function generateDailySummary() {
  if (!AI_API_URL || !AI_API_KEY) {
    return;
  }
  const date = todayStr();
  const range = utcRangeForLocalDate(date, new Date().getTimezoneOffset());
  if (!range) {
    console.error(`[ai-summary] Invalid summary date: ${date}`);
    return;
  }
  const rows = getDailyActivityRows.all(range.start, range.end);
  if (rows.length === 0) {
    console.log("[ai-summary] No activity data for today, skipping");
    return;
  }
  const userPrompt = buildUserPrompt(rows);
  try {
    const controller = new AbortController;
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(AI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AI_API_KEY}`
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 200,
        temperature: 0.7
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      console.error(`[ai-summary] API returned ${res.status}: ${await res.text()}`);
      return;
    }
    const data = await res.json();
    const summary = data?.choices?.[0]?.message?.content?.trim();
    if (!summary) {
      console.error("[ai-summary] Empty response from AI");
      return;
    }
    upsertDailySummary.run(date, summary);
    console.log(`[ai-summary] Generated summary for ${date}: ${summary.slice(0, 60)}...`);
  } catch (e) {
    console.error("[ai-summary] Failed to generate:", e);
  }
}

// packages/backend/src/services/cleanup.ts
var hourlyCleanupTimer = setInterval(() => {
  try {
    const result = cleanupOldActivities.run();
    if (result.changes > 0) {
      console.log(`[cleanup] Deleted ${result.changes} old activity records`);
    }
  } catch (e) {
    console.error("[cleanup] Activities cleanup failed:", e);
  }
  try {
    const locationResult = cleanupOldLocations.run();
    if (locationResult.changes > 0) {
      console.log(`[cleanup] Deleted ${locationResult.changes} old location records`);
    }
  } catch (e) {
    console.error("[cleanup] Locations cleanup failed:", e);
  }
  try {
    const messageResult = cleanupExpiredMessages.run();
    if (messageResult.changes > 0) {
      console.log(`[cleanup] Deleted ${messageResult.changes} expired device messages`);
    }
  } catch (e) {
    console.error("[cleanup] Messages cleanup failed:", e);
  }
  try {
    const summaryResult = cleanupOldSummaries.run();
    if (summaryResult.changes > 0) {
      console.log(`[cleanup] Deleted ${summaryResult.changes} old daily summaries`);
    }
  } catch (e) {
    console.error("[cleanup] Summaries cleanup failed:", e);
  }
  try {
    optimizeDatabase();
  } catch (e) {
    console.error("[cleanup] SQLite optimize failed:", e);
  }
}, 60 * 60 * 1000);
hourlyCleanupTimer.unref();
var offlineTimer = setInterval(() => {
  try {
    markOfflineDevices.run();
  } catch {}
}, 60000);
offlineTimer.unref();
var lastSummaryDate = "";
var summaryTimer = setInterval(() => {
  const now = new Date;
  if (now.getHours() === 21 && now.getMinutes() === 0) {
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (today !== lastSummaryDate) {
      lastSummaryDate = today;
      generateDailySummary().catch((e) => console.error("[cleanup] AI summary failed:", e));
    }
  }
}, 60000);
summaryTimer.unref();
console.log("[cleanup] Scheduled: hourly cleanup, 60s offline check, 21:00 AI summary");

// packages/backend/src/index.ts
init_db();
var PORT = parseInt(process.env.PORT || "3000", 10);
if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`[server] Invalid PORT: ${process.env.PORT}, using 3000`);
}
var LISTEN_PORT = isNaN(PORT) || PORT < 1 || PORT > 65535 ? 3000 : PORT;
var STATIC_ROOT = resolve(process.env.STATIC_DIR || "./public");
var REQUIRE_EDGE = /^(1|true|yes)$/i.test(process.env.REQUIRE_EDGE || "");
var REAL_STATIC_ROOT = "";
var staticEnabled = false;
try {
  REAL_STATIC_ROOT = realpathSync(STATIC_ROOT);
  staticEnabled = true;
} catch {
  console.warn(`[server] Static dir not found: ${STATIC_ROOT} \u2014 static files won't be served`);
}
async function serveStaticFile(realFile) {
  if (realFile.endsWith(".html")) {
    const html = await Bun.file(realFile).text();
    return noStore(new Response(injectSiteConfig(html), {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    }), ["page", "page-index"]);
  }
  return withCdnHeaders(new Response(Bun.file(realFile)), staticCacheTags(realFile), 60 * 60 * 24 * 30);
}
function staticCacheTags(realFile) {
  const rel = relative(REAL_STATIC_ROOT, realFile).replaceAll("\\", "/");
  const safe = rel.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return ["static", ...safe ? [`static-${safe}`] : []];
}
var server = Bun.serve({
  port: LISTEN_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;
    const host = req.headers.get("host") || "";
    const isLocalhost = host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]");
    const isDirectIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(host);
    if (isDirectIp && !isLocalhost) {
      return Response.json({ error: "Direct IP access not allowed" }, { status: 403 });
    }
    const isWs = req.headers.get("upgrade")?.toLowerCase() === "websocket" || pathname === "/api/ws";
    const isApi = pathname.startsWith("/api/");
    if (REQUIRE_EDGE && isApi && pathname !== "/api/health" && req.method !== "OPTIONS" && !isWs) {
      const edgeSig = req.headers.get("x-edge-internal");
      if (!edgeSig) {
        return Response.json({ error: "\u5FC5\u987B\u901A\u8FC7\u8FB9\u7F18\u51FD\u6570\u8BBF\u95EE" }, { status: 403 });
      }
      const expected = hmacTitle("edge-internal");
      if (edgeSig !== expected) {
        return Response.json({ error: "\u8FB9\u7F18\u7B7E\u540D\u65E0\u6548" }, { status: 403 });
      }
    }
    const isPublicEndpoint = pathname === "/api/current" || pathname === "/api/timeline" || pathname === "/api/health" || pathname === "/api/daily-summary" || pathname === "/api/config" || pathname === "/api/messages/public" || pathname === "/api/messages/private" || pathname === "/api/pow/challenge" || pathname === "/api/token/issue" || pathname === "/api/health-data" && req.method === "GET" || pathname === "/api/location" && req.method === "GET";
    const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) || [];
    const requestOrigin = req.headers.get("origin");
    let corsHeaders = {
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };
    if (isPublicEndpoint) {
      corsHeaders["Access-Control-Allow-Origin"] = "*";
    } else if (allowedOrigins.length > 0 && requestOrigin && allowedOrigins.includes(requestOrigin)) {
      corsHeaders["Access-Control-Allow-Origin"] = requestOrigin;
    } else if (allowedOrigins.length === 0 && isPublicEndpoint) {
      corsHeaders["Access-Control-Allow-Origin"] = "*";
    }
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    const clientIpForRate = normalizeClientIp(req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || req.headers.get("cf-connecting-ip") || server.requestIP(req)?.address || "unknown");
    const authHeader = req.headers.get("authorization") || "";
    const hasDeviceToken = authenticateToken(authHeader) !== null;
    const isAuthEndpoint = pathname === "/api/pow/challenge" || pathname === "/api/token/issue";
    const isViewerAuthGet = req.method === "GET" && (pathname === "/api/health-data" || pathname === "/api/location" || pathname === "/api/ws");
    if (!hasDeviceToken && !(isPublicEndpoint && req.method === "GET") && !isAuthEndpoint && !isViewerAuthGet && !globalIpRateLimit(clientIpForRate)) {
      return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
    }
    if (pathname === "/api/pow/challenge" && req.method === "GET") {
      if (!powChallengeRateLimit(clientIpForRate)) {
        return Response.json({ error: "Too many PoW requests", retryAfter: 60 }, { status: 429 });
      }
    }
    if (req.method === "POST" || req.method === "PUT" || req.method === "DELETE") {
      const contentLength = parseInt(req.headers.get("content-length") || "0", 10);
      if (contentLength > 1024 * 1024) {
        return Response.json({ error: "Payload too large" }, { status: 413 });
      }
    }
    let response;
    try {
      const clientIp = normalizeClientIp(req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || req.headers.get("cf-connecting-ip") || server.requestIP(req)?.address || "");
      if (pathname === "/api/ws") {
        const wsInfo = await getWsInfo(req);
        if (wsInfo instanceof Response)
          return wsInfo;
        if (server.upgrade(req, { data: wsInfo })) {
          return;
        }
        return Response.json({ error: "WebSocket upgrade failed" }, { status: 400 });
      } else if (pathname === "/api/report" && req.method === "POST") {
        response = await handleReport(req);
      } else if (pathname === "/api/current" && req.method === "GET") {
        response = handleCurrent(req, clientIp, req.headers.get("user-agent") || undefined);
        response = noStore(response, ["current", "realtime", "status"]);
      } else if (pathname === "/api/timeline" && req.method === "GET") {
        response = handleTimeline(url);
      } else if (pathname === "/api/health" && req.method === "GET") {
        response = handleHealth();
      } else if (pathname === "/api/health-data" && req.method === "POST") {
        response = await handleHealthData(req);
      } else if (pathname === "/api/health-data" && req.method === "GET") {
        response = handleHealthDataQuery(url, req);
      } else if (pathname === "/api/health-webhook" && req.method === "POST") {
        response = await handleHealthWebhook(req);
      } else if (pathname === "/api/config" && req.method === "GET") {
        response = handleConfig();
      } else if (pathname === "/api/daily-summary" && req.method === "GET") {
        response = handleDailySummary(url);
      } else if (pathname === "/api/location" && req.method === "GET") {
        response = handleLocationQuery(url, req);
      } else if (pathname === "/api/messages" && req.method === "GET") {
        response = handleDeviceMessages(req);
      } else if (pathname === "/api/messages/history" && req.method === "GET") {
        response = handleDeviceMessageHistory(req);
      } else if (pathname === "/api/messages/reply" && req.method === "POST") {
        response = await handleDeviceMessageReply(req);
      } else if (pathname === "/api/messages/delete" && req.method === "POST") {
        response = await handleDeleteMessage(req);
      } else if (pathname === "/api/messages/viewer/delete" && req.method === "POST") {
        response = await handleDeleteViewerMessages(req);
      } else if (pathname === "/api/messages/remark" && req.method === "POST") {
        response = await handleSetRemark(req);
      } else if (pathname === "/api/messages/block" && req.method === "POST") {
        response = await handleBlockViewer(req);
      } else if (pathname === "/api/messages/unblock" && req.method === "POST") {
        response = await handleUnblockViewer(req);
      } else if (pathname === "/api/messages/public" && req.method === "GET") {
        response = handlePublicMessages(req);
      } else if (pathname === "/api/messages/public" && req.method === "POST") {
        response = await handlePublicMessagePost(req);
      } else if (pathname === "/api/messages/private" && req.method === "POST") {
        response = await handlePrivateMessagePost(req);
      } else if (pathname === "/api/pow/challenge" && req.method === "GET") {
        response = handlePowChallenge(req, clientIp);
      } else if (pathname === "/api/token/issue" && req.method === "POST") {
        response = await handleViewerTokenIssue(req, clientIp);
      } else if (pathname === "/api/device" && req.method === "DELETE") {
        response = await handleDeleteDevice(req);
      } else if (!pathname.startsWith("/api/")) {
        if (!staticEnabled) {
          response = Response.json({ error: "Not found" }, { status: 404 });
        } else {
          if (pathname === "/favicon.ico") {
            const faviconFile = Bun.file(`${REAL_STATIC_ROOT}/favicon.ico`);
            if (await faviconFile.exists()) {
              return withCdnHeaders(new Response(faviconFile, {
                headers: { "Content-Type": "image/x-icon" }
              }), ["static", "static-favicon-ico"], 60 * 60 * 24 * 30);
            }
            const iconFile = Bun.file(`${REAL_STATIC_ROOT}/icon.svg`);
            if (await iconFile.exists()) {
              return withCdnHeaders(new Response(iconFile, {
                headers: { "Content-Type": "image/svg+xml" }
              }), ["static", "static-favicon-ico", "static-icon-svg"], 60 * 60 * 24 * 30);
            }
          }
          let decoded;
          try {
            decoded = decodeURIComponent(pathname);
          } catch {
            return new Response("Bad request", { status: 400 });
          }
          const safePath = normalize(decoded).replace(/^(\.\.[\/\\])+/, "");
          const resolved = resolve(STATIC_ROOT, safePath.replace(/^[\/\\]+/, ""));
          const rel = relative(STATIC_ROOT, resolved);
          if (rel.startsWith("..")) {
            response = Response.json({ error: "Forbidden" }, { status: 403 });
          } else {
            try {
              const realFile = await realpathAsync(resolved);
              if (realFile !== REAL_STATIC_ROOT && !realFile.startsWith(REAL_STATIC_ROOT + sep)) {
                response = Response.json({ error: "Forbidden" }, { status: 403 });
              } else {
                const file = Bun.file(realFile);
                if (await file.exists()) {
                  return serveStaticFile(realFile);
                }
                const indexFile = Bun.file(`${REAL_STATIC_ROOT}/index.html`);
                if (await indexFile.exists()) {
                  return serveStaticFile(`${REAL_STATIC_ROOT}/index.html`);
                }
                response = Response.json({ error: "Not found" }, { status: 404 });
              }
            } catch {
              const indexFile = Bun.file(`${REAL_STATIC_ROOT}/index.html`);
              if (await indexFile.exists()) {
                return serveStaticFile(`${REAL_STATIC_ROOT}/index.html`);
              }
              response = Response.json({ error: "Not found" }, { status: 404 });
            }
          }
        }
      } else {
        response = Response.json({ error: "Not found" }, { status: 404 });
      }
    } catch (e) {
      console.error("[server] Unhandled error:", e);
      response = Response.json({ error: "Internal error" }, { status: 500 });
    }
    for (const [key, value] of Object.entries(corsHeaders)) {
      response.headers.set(key, value);
    }
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("X-Frame-Options", "SAMEORIGIN");
    response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    return response;
  },
  websocket: realtimeWebSocket
});
var cdnMode = /^(1|true|yes)$/i.test(process.env.CDN_MODE || "");
var nsfwDisabled = process.env.NSFW_FILTER_DISABLED === "true";
var messageBoard = process.env.MESSAGE_BOARD_ENABLED !== "false";
var privateChat = process.env.PRIVATE_CHAT_ENABLED !== "false";
var aiEnabled = !!(process.env.AI_API_URL && process.env.AI_API_KEY);
var aiModel = process.env.AI_MODEL || "";
var corsOrigins = process.env.CORS_ALLOWED_ORIGINS?.split(",").filter(Boolean).length || 0;
var displayName = process.env.DISPLAY_NAME || "";
var siteTitle = process.env.SITE_TITLE || "";
var dbPath = process.env.DB_PATH || "./data.db";
var Y = "\x1B[33m";
var G = "\x1B[32m";
var RD = "\x1B[31m";
var R = "\x1B[0m";
var DIM = "\x1B[2m";
function strWidth(s) {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    w += code > 127 && code < 65536 ? 2 : 1;
  }
  return w;
}
function padR(s, target) {
  return s + " ".repeat(Math.max(0, target - strWidth(s)));
}
var W = 40;
var line = (label, value, color = "") => `  \u2502 ${color}${padR(label + value, W)}${color ? R : ""}\u2502`;
var powDisabled = /^(1|true|yes)$/i.test(process.env.POW_DISABLED || "");
var tlsCheckDisabled = /^(1|true|yes)$/i.test(process.env.TLS_CHECK_DISABLED || "");
var hashSecretLen = (process.env.HASH_SECRET || "").length;
console.log("");
console.log("  \u256D" + "\u2500".repeat(W + 2) + "\u256E");
console.log("  \u2502" + padR("  Live Dashboard \u542F\u52A8", W + 2) + "\u2502");
console.log("  \u251C" + "\u2500".repeat(W + 2) + "\u2524");
console.log(line("\u5730\u5740:     ", `http://localhost:${server.port}`));
if (siteTitle)
  console.log(line("\u7AD9\u70B9:     ", siteTitle));
console.log(line("\u6A21\u5F0F:     ", cdnMode ? `${G}CDN \u52A0\u901F${R}` : "\u76F4\u8FDE"));
console.log(line("\u6570\u636E\u5E93:   ", dbPath));
console.log(line("\u9759\u6001\u6587\u4EF6: ", staticEnabled ? "\u5DF2\u52A0\u8F7D" : `${Y}\u672A\u627E\u5230${R}`));
console.log("  \u251C" + "\u2500".repeat(W + 2) + "\u2524");
console.log(line("\u7559\u8A00\u677F:   ", messageBoard ? "\u5F00\u542F" : "\u5173\u95ED"));
console.log(line("\u79C1\u804A:     ", privateChat ? "\u5F00\u542F" : "\u5173\u95ED"));
console.log(line("AI \u603B\u7ED3:  ", aiEnabled ? "\u5F00\u542F" : "\u5173\u95ED"));
if (aiEnabled && aiModel)
  console.log(line("AI \u6A21\u578B:  ", aiModel));
console.log(line("NSFW \u8FC7\u6EE4:", nsfwDisabled ? `${Y}\u5DF2\u5173\u95ED${R}` : "\u5F00\u542F"));
console.log(line("PoW \u9A8C\u8BC1: ", powDisabled ? `${RD}\u5DF2\u5173\u95ED${R}` : "\u5F00\u542F"));
console.log(line("TLS \u68C0\u67E5: ", tlsCheckDisabled ? `${RD}\u5DF2\u5173\u95ED${R}` : "\u5F00\u542F"));
console.log(line("CORS:     ", corsOrigins ? `${corsOrigins} \u4E2A\u57DF\u540D` : "\u4EC5\u540C\u6E90"));
console.log(line("\u5BC6\u94A5:     ", hashSecretLen >= 64 ? `${G}\u5DF2\u914D\u7F6E (${hashSecretLen} \u4F4D)${R}` : hashSecretLen > 0 ? `${Y}\u8F83\u77ED (${hashSecretLen} \u4F4D)${R}` : `${RD}\u672A\u8BBE\u7F6E${R}`));
if (displayName)
  console.log(line("\u663E\u793A\u540D:   ", displayName));
console.log("  \u2570" + "\u2500".repeat(W + 2) + "\u256F");
var validPlatforms = new Set(["windows", "android", "macos", "zepp"]);
var envTokens = Object.entries(process.env).filter(([k]) => k.startsWith("DEVICE_TOKEN_") && k.match(/^DEVICE_TOKEN_\d+$/));
var loadedCount = 0;
var invalidCount = 0;
var deviceNames = [];
for (const [key, value] of envTokens) {
  if (!value)
    continue;
  const parts = value.split(":");
  if (parts.length < 4) {
    invalidCount++;
    console.log(`  ${RD}\u2717 ${key}: \u683C\u5F0F\u9519\u8BEF\uFF0C\u9700\u8981 \u5BC6\u94A5:\u8BBE\u5907ID:\u663E\u793A\u540D:\u5E73\u53F0${R}`);
  } else {
    const platform = parts[parts.length - 1];
    const deviceName = parts.slice(2, -1).join(":");
    if (!platform || !validPlatforms.has(platform)) {
      invalidCount++;
      console.log(`  ${RD}\u2717 ${key}: \u5E73\u53F0 "${platform}" \u65E0\u6548\uFF0C\u5FC5\u987B\u662F windows/android/macos/zepp${R}`);
    } else {
      loadedCount++;
      deviceNames.push(`${deviceName} (${platform})`);
    }
  }
}
if (envTokens.length > 0) {
  console.log(`  \u8BBE\u5907\u4EE4\u724C: ${G}${loadedCount} \u4E2A\u5DF2\u52A0\u8F7D${R}${invalidCount > 0 ? `\uFF0C${RD}${invalidCount} \u4E2A\u9519\u8BEF${R}` : ""}`);
  for (const name of deviceNames) {
    console.log(`  ${DIM}  \u2514\u2500 ${name}${R}`);
  }
} else {
  console.log(`  ${RD}\u2717 \u672A\u914D\u7F6E\u8BBE\u5907\u4EE4\u724C\uFF0CAgent \u65E0\u6CD5\u8FDE\u63A5${R}`);
}
var tips = [];
if (hashSecretLen === 0)
  tips.push("HASH_SECRET \u672A\u8BBE\u7F6E\uFF0C\u670D\u52A1\u65E0\u6CD5\u542F\u52A8");
if (hashSecretLen > 0 && hashSecretLen < 64)
  tips.push("HASH_SECRET \u8F83\u77ED\uFF0C\u5EFA\u8BAE\u4F7F\u7528 openssl rand -hex 32 \u751F\u6210");
if (!displayName)
  tips.push("\u8BBE\u7F6E DISPLAY_NAME \u81EA\u5B9A\u4E49\u663E\u793A\u540D\u79F0");
if (nsfwDisabled)
  tips.push("NSFW \u8FC7\u6EE4\u5DF2\u5173\u95ED\uFF0C\u654F\u611F\u5185\u5BB9\u5C06\u76F4\u63A5\u663E\u793A");
if (!cdnMode)
  tips.push("\u8BBE\u7F6E CDN_MODE=true \u542F\u7528 CDN \u52A0\u901F");
if (invalidCount > 0)
  tips.push("\u68C0\u67E5 DEVICE_TOKEN \u683C\u5F0F: \u5BC6\u94A5:\u8BBE\u5907ID:\u663E\u793A\u540D:\u5E73\u53F0");
if (powDisabled)
  tips.push("PoW \u9A8C\u8BC1\u5DF2\u5173\u95ED\uFF0C\u4EFB\u4F55\u4EBA\u90FD\u53EF\u4EE5\u83B7\u53D6\u8BBF\u5BA2\u4EE4\u724C");
if (tlsCheckDisabled)
  tips.push("TLS \u68C0\u67E5\u5DF2\u5173\u95ED\uFF0C\u673A\u5668\u4EBA\u8BF7\u6C42\u4E0D\u4F1A\u88AB\u62E6\u622A");
if (tips.length > 0) {
  console.log("");
  for (const tip of tips) {
    const isDanger = tip.includes("\u5DF2\u5173\u95ED") || tip.includes("\u683C\u5F0F\u9519\u8BEF") || tip.includes("\u672A\u8BBE\u7F6E");
    const isWarn = tip.includes("\u8F83\u77ED") || tip.includes("CDN");
    const color = isDanger ? RD : isWarn ? Y : Y;
    console.log(`  ${color}\uD83D\uDCA1 ${tip}${R}`);
  }
}
console.log("");
