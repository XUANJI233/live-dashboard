import { db, cleanupExpiredDeviceScreenshots } from "../db";
import { cleanIdentifier, cleanLooseIdentifier, cleanText } from "./mcp-contracts";

const SCREENSHOT_TTL_MS = 10 * 60_000;
const MAX_SCREENSHOT_BYTES = 768 * 1024;
const waiters = new Map<string, Set<(record: DeviceScreenshotRecord | null) => void>>();

const insertRequest = db.prepare(`
  INSERT INTO device_screenshots (
    screenshot_id, command_id, device_id, status, created_at, expires_at
  ) VALUES (?, ?, ?, 'pending', ?, ?)
`);

const updateReady = db.prepare(`
  UPDATE device_screenshots
  SET status = 'ready', mime_type = ?, width = ?, height = ?, image_data = ?,
      error = '', uploaded_at = ?
  WHERE screenshot_id = ? AND command_id = ? AND device_id = ?
    AND status = 'pending' AND datetime(expires_at) >= datetime('now')
`);

const updateFailed = db.prepare(`
  UPDATE device_screenshots
  SET status = 'failed', error = ?
  WHERE screenshot_id = ? AND status = 'pending'
`);

const getScreenshot = db.prepare(`
  SELECT screenshot_id, command_id, device_id, status, mime_type, width, height,
         image_data, error, created_at, expires_at, uploaded_at
  FROM device_screenshots
  WHERE screenshot_id = ? AND datetime(expires_at) >= datetime('now')
  LIMIT 1
`);

const deleteScreenshot = db.prepare("DELETE FROM device_screenshots WHERE screenshot_id = ?");

export interface DeviceScreenshotRecord {
  screenshot_id: string;
  command_id: string;
  device_id: string;
  status: "pending" | "ready" | "failed";
  mime_type: string;
  width: number;
  height: number;
  image_data: Uint8Array | null;
  error: string;
  created_at: string;
  expires_at: string;
  uploaded_at: string;
}

export function createScreenshotRequest(input: {
  screenshotId: string;
  commandId: string;
  deviceId: string;
}): DeviceScreenshotRecord {
  cleanupExpiredDeviceScreenshots.run();
  const screenshotId = cleanIdentifier(input.screenshotId);
  const commandId = cleanIdentifier(input.commandId);
  const deviceId = cleanLooseIdentifier(input.deviceId, 160);
  if (!screenshotId || !commandId || !deviceId) throw new Error("invalid_screenshot_request");
  const createdAt = new Date();
  insertRequest.run(
    screenshotId,
    commandId,
    deviceId,
    createdAt.toISOString(),
    new Date(createdAt.getTime() + SCREENSHOT_TTL_MS).toISOString(),
  );
  return readScreenshot(screenshotId)!;
}

export function storeScreenshotUpload(input: {
  screenshotId: string;
  commandId: string;
  deviceId: string;
  mimeType: string;
  width: number;
  height: number;
  imageData: Uint8Array;
}): { stored: boolean; error?: string; record?: DeviceScreenshotRecord } {
  const screenshotId = cleanIdentifier(input.screenshotId);
  const commandId = cleanIdentifier(input.commandId);
  const deviceId = cleanLooseIdentifier(input.deviceId, 160);
  if (!screenshotId || !commandId || !deviceId) return { stored: false, error: "invalid_screenshot_upload" };
  if (input.mimeType !== "image/jpeg") return { stored: false, error: "unsupported_screenshot_type" };
  if (!(input.imageData instanceof Uint8Array) || input.imageData.byteLength < 4) {
    return { stored: false, error: "invalid_screenshot_data" };
  }
  if (input.imageData.byteLength > MAX_SCREENSHOT_BYTES) {
    return { stored: false, error: "screenshot_too_large" };
  }
  const width = boundedDimension(input.width);
  const height = boundedDimension(input.height);
  if (!width || !height) return { stored: false, error: "invalid_screenshot_dimensions" };

  const result = updateReady.run(
    input.mimeType,
    width,
    height,
    input.imageData,
    new Date().toISOString(),
    screenshotId,
    commandId,
    deviceId,
  );
  if (result.changes === 0) return { stored: false, error: "screenshot_request_not_pending" };
  const record = readScreenshot(screenshotId)!;
  notifyWaiters(screenshotId, record);
  return { stored: true, record };
}

export function failScreenshotRequest(screenshotIdValue: string, error: string): void {
  const screenshotId = cleanIdentifier(screenshotIdValue);
  if (!screenshotId) return;
  updateFailed.run(cleanText(error, 120), screenshotId);
  notifyWaiters(screenshotId, readScreenshot(screenshotId));
}

export function readScreenshot(screenshotIdValue: string): DeviceScreenshotRecord | null {
  const screenshotId = cleanIdentifier(screenshotIdValue);
  if (!screenshotId) return null;
  const row = getScreenshot.get(screenshotId) as DeviceScreenshotRecord | null;
  if (!row) return null;
  return {
    ...row,
    image_data: row.image_data ? new Uint8Array(row.image_data) : null,
  };
}

export function consumeScreenshot(screenshotIdValue: string): DeviceScreenshotRecord | null {
  const record = readScreenshot(screenshotIdValue);
  if (!record || record.status !== "ready" || !record.image_data) return record;
  deleteScreenshot.run(record.screenshot_id);
  return record;
}

export async function waitForScreenshot(
  screenshotIdValue: string,
  timeoutMs: number,
): Promise<DeviceScreenshotRecord | null> {
  const screenshotId = cleanIdentifier(screenshotIdValue);
  if (!screenshotId) return null;
  const current = readScreenshot(screenshotId);
  if (!current || current.status !== "pending" || timeoutMs <= 0) return current;
  return await new Promise((resolve) => {
    const listeners = waiters.get(screenshotId) ?? new Set();
    let settled = false;
    const finish = (record: DeviceScreenshotRecord | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      listeners.delete(finish);
      if (listeners.size === 0) waiters.delete(screenshotId);
      resolve(record);
    };
    listeners.add(finish);
    waiters.set(screenshotId, listeners);
    const timer = setTimeout(() => finish(readScreenshot(screenshotId)), timeoutMs);
    const afterRegistration = readScreenshot(screenshotId);
    if (!afterRegistration || afterRegistration.status !== "pending") finish(afterRegistration);
  });
}

export function maxScreenshotBytes(): number {
  return MAX_SCREENSHOT_BYTES;
}

function notifyWaiters(screenshotId: string, record: DeviceScreenshotRecord | null): void {
  const listeners = waiters.get(screenshotId);
  if (!listeners) return;
  for (const listener of Array.from(listeners)) listener(record);
}

function boundedDimension(value: number): number {
  return Number.isInteger(value) && value > 0 && value <= 10_000 ? value : 0;
}
