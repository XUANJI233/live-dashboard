import { Database } from "bun:sqlite";

const DB_PATH = process.env.DB_PATH || "./live-dashboard.db";
const SQLITE_BUSY_TIMEOUT_MS = positiveIntegerEnv("SQLITE_BUSY_TIMEOUT_MS", 5000);
const SQLITE_WAL_AUTOCHECKPOINT_PAGES = positiveIntegerEnv("SQLITE_WAL_AUTOCHECKPOINT_PAGES", 1000);
const SQLITE_CACHE_SIZE_KIB = positiveIntegerEnv("SQLITE_CACHE_SIZE_KIB", 32 * 1024);
const SQLITE_MMAP_SIZE_BYTES = positiveIntegerEnv("SQLITE_MMAP_SIZE_BYTES", 256 * 1024 * 1024);
const SQLITE_JOURNAL_SIZE_LIMIT_BYTES = positiveIntegerEnv("SQLITE_JOURNAL_SIZE_LIMIT_BYTES", 64 * 1024 * 1024);

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export const db = new Database(DB_PATH, { create: true });

// SQLite pragmas are mostly connection-scoped, so reapply them on each startup.
db.run("PRAGMA foreign_keys = ON");
db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
const journalMode = db.query("PRAGMA journal_mode = WAL").get() as { journal_mode?: string } | null;
if (journalMode?.journal_mode?.toLowerCase() !== "wal") {
  console.warn(`[db] SQLite WAL mode was not enabled, current journal_mode=${journalMode?.journal_mode ?? "unknown"}`);
}
db.run("PRAGMA synchronous = NORMAL");
db.run(`PRAGMA wal_autocheckpoint = ${SQLITE_WAL_AUTOCHECKPOINT_PAGES}`);
db.run(`PRAGMA cache_size = -${SQLITE_CACHE_SIZE_KIB}`);
db.run(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
db.run(`PRAGMA journal_size_limit = ${SQLITE_JOURNAL_SIZE_LIMIT_BYTES}`);
db.run("PRAGMA temp_store = MEMORY");

export function optimizeDatabase(startup = false): void {
  db.run(startup ? "PRAGMA optimize=0x10002" : "PRAGMA optimize");
}

// Activities table
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

// Dedup unique constraint
db.run(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_dedup
  ON activities(device_id, app_id, title_hash, time_bucket)
`);

// Query indexes
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

// Device states table
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

// ── Schema migration: add display_title + extra columns ──

const KNOWN_TABLES = new Set(["activities", "device_states", "device_messages", "daily_summaries", "weekly_summaries"]);

function columnExists(table: string, column: string): boolean {
  if (!KNOWN_TABLES.has(table)) {
    throw new Error(`columnExists: unknown table "${table}"`);
  }
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

// activities.display_title
if (!columnExists("activities", "display_title")) {
  db.run("ALTER TABLE activities ADD COLUMN display_title TEXT DEFAULT ''");
}

// device_states.display_title
if (!columnExists("device_states", "display_title")) {
  db.run("ALTER TABLE device_states ADD COLUMN display_title TEXT DEFAULT ''");
}

// device_states.extra (JSON string for battery, etc.)
if (!columnExists("device_states", "extra")) {
  db.run("ALTER TABLE device_states ADD COLUMN extra TEXT DEFAULT '{}'");
}

// ── Health records table ──

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

// ── Location records table ──

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

// ── Short-lived viewer -> device messages ──

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

const deviceMessageColumns = db.prepare("PRAGMA table_info(device_messages)").all() as { name: string; pk: number }[];
const oldDeviceMessagePk = deviceMessageColumns.some((column) => column.name === "id" && column.pk === 1) &&
  !deviceMessageColumns.some((column) => column.name === "device_id" && column.pk > 0);
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

if (!columnExists("device_messages", "payload")) {
  db.run("ALTER TABLE device_messages ADD COLUMN payload TEXT NOT NULL DEFAULT ''");
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

// Daily summaries table (AI-generated)
db.run(`
  CREATE TABLE IF NOT EXISTS daily_summaries (
    date TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'normal',
    target TEXT NOT NULL DEFAULT '',
    generated_at TEXT DEFAULT (datetime('now'))
  )
`);

if (!columnExists("daily_summaries", "mode")) {
  db.run("ALTER TABLE daily_summaries ADD COLUMN mode TEXT NOT NULL DEFAULT 'normal'");
}

if (!columnExists("daily_summaries", "target")) {
  db.run("ALTER TABLE daily_summaries ADD COLUMN target TEXT NOT NULL DEFAULT ''");
}

// Weekly summaries table (AI-generated)
db.run(`
  CREATE TABLE IF NOT EXISTS weekly_summaries (
    week_start TEXT PRIMARY KEY,
    week_end TEXT NOT NULL,
    summary TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'normal',
    target TEXT NOT NULL DEFAULT '',
    generated_at TEXT DEFAULT (datetime('now'))
  )
`);

optimizeDatabase(true);

// ── HMAC hash secret validation ──

export const HASH_SECRET = process.env.HASH_SECRET || "";
if (!HASH_SECRET) {
  console.error("[启动失败] HASH_SECRET 未设置");
  console.error("[启动失败] 这是必要的安全密钥，请在 .env 中配置");
  console.error("[启动失败] 生成方式: openssl rand -hex 32");
  process.exit(1);
}
if (!/^[0-9a-f]{32,128}$/i.test(HASH_SECRET)) {
  console.error(`[启动失败] HASH_SECRET 格式无效: "${HASH_SECRET.slice(0, 8)}..."`);
  console.error("[启动失败] 要求: 32-128 位十六进制字符串 (0-9, a-f)");
  console.error("[启动失败] 生成方式: openssl rand -hex 32");
  process.exit(1);
}

export function hmacTitle(title: string): string {
  const hmac = new Bun.CryptoHasher("sha256", HASH_SECRET);
  hmac.update(title);
  return hmac.digest("hex");
}

// Prepared statements
export const insertActivity = db.prepare(`
  INSERT INTO activities (device_id, device_name, platform, app_id, app_name, window_title, display_title, title_hash, time_bucket, started_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(device_id, app_id, title_hash, time_bucket) DO NOTHING
`);

export const upsertDeviceState = db.prepare(`
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

export const getAllDeviceStates = db.prepare(`
  SELECT * FROM device_states ORDER BY last_seen_at DESC
`);

export const getRecentActivities = db.prepare(`
  SELECT * FROM activities ORDER BY started_at DESC LIMIT 20
`);

export const markOfflineDevices = db.prepare(`
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

export const cleanupOldActivities = db.prepare(`
  DELETE FROM activities WHERE created_at < datetime('now', '-7 days')
`);

export const cleanupExpiredMessages = db.prepare(`
  DELETE FROM device_messages WHERE datetime(expires_at) < datetime('now')
`);

export const insertLocationRecord = db.prepare(`
  INSERT INTO location_records (device_id, latitude, longitude, accuracy_m, provider, recorded_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(device_id, recorded_at) DO NOTHING
`);

export const cleanupOldLocations = db.prepare(`
  DELETE FROM location_records WHERE created_at < datetime('now', '-30 days')
`);

export const upsertDailySummary = db.prepare(`
  INSERT INTO daily_summaries (date, summary, mode, target, generated_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT(date) DO UPDATE SET
    summary = excluded.summary,
    mode = excluded.mode,
    target = excluded.target,
    generated_at = datetime('now')
`);

export const getDailySummary = db.prepare(`
  SELECT * FROM daily_summaries WHERE date = ?
`);

export const cleanupOldSummaries = db.prepare(`
  DELETE FROM daily_summaries WHERE date < date('now', '-30 days')
`);

export const upsertWeeklySummary = db.prepare(`
  INSERT INTO weekly_summaries (week_start, week_end, summary, mode, target, generated_at)
  VALUES (?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(week_start) DO UPDATE SET
    week_end = excluded.week_end,
    summary = excluded.summary,
    mode = excluded.mode,
    target = excluded.target,
    generated_at = datetime('now')
`);

export const getWeeklySummary = db.prepare(`
  SELECT * FROM weekly_summaries WHERE week_start = ?
`);

export const cleanupOldWeeklySummaries = db.prepare(`
  DELETE FROM weekly_summaries WHERE week_start < date('now', '-120 days')
`);

// ── Push notification subscriptions (Web Push API) ──
db.run(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    viewer_id TEXT NOT NULL PRIMARY KEY,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// ── Server metadata (VAPID keys, etc.) ──
db.run(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

export function metaGet(key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function metaSet(key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

// ── Device deletion ──
export const deleteDevice = db.prepare(`
  DELETE FROM device_states WHERE device_id = ?
`);
export const deleteDeviceActivities = db.prepare(`
  DELETE FROM activities WHERE device_id = ?
`);

export default db;
