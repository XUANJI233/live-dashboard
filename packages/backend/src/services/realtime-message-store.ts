import { db } from "../db";
import type { MessageDirection, StoredMessageKind } from "./message-protocol";
import { deleteQueuedMessage, deleteQueuedMessagesForViewer } from "./realtime-message-queue-store";

export interface MessageTargetDeviceRow {
  device_id: string;
}

export interface VisitorMessageForDelete {
  id: string;
  device_id: string;
  viewer_id: string;
  kind: string;
}

const isViewerBlockedStmt = db.prepare(`
  SELECT 1
  FROM blocked_viewers
  WHERE device_id = ? AND viewer_id = ?
  LIMIT 1
`);

const blockViewerStmt = db.prepare(`
  INSERT INTO blocked_viewers (device_id, viewer_id)
  VALUES (?, ?)
  ON CONFLICT(device_id, viewer_id) DO UPDATE SET blocked_at = datetime('now')
`);

const unblockViewerStmt = db.prepare(`
  DELETE FROM blocked_viewers
  WHERE device_id = ? AND viewer_id = ?
`);

const insertVisitorMessage = db.prepare(`
  INSERT INTO visitor_messages (id, device_id, viewer_id, viewer_name, kind, direction, text, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`);

const deleteVisitorMessage = db.prepare(`
  DELETE FROM visitor_messages
  WHERE id = ?
    AND (device_id = ? OR kind IN ('public', 'public_reply'))
`);

const deleteVisitorMessagesByViewer = db.prepare(`
  DELETE FROM visitor_messages
  WHERE device_id = ? AND viewer_id = ? AND kind IN ('private', 'reply')
`);

const getVisitorMessageForDelete = db.prepare(`
  SELECT id, device_id, viewer_id, kind
  FROM visitor_messages
  WHERE id = ?
  LIMIT 1
`);

const getVisitorMessageKind = db.prepare(`
  SELECT kind
  FROM visitor_messages
  WHERE id = ?
  LIMIT 1
`);

const upsertViewerRemark = db.prepare(`
  INSERT INTO viewer_remarks (device_id, viewer_id, remark)
  VALUES (?, ?, ?)
  ON CONFLICT(device_id, viewer_id) DO UPDATE SET
    remark = excluded.remark,
    updated_at = datetime('now')
`);

const getDeviceMessageHistory = db.prepare(`
  SELECT m.id, m.device_id, m.viewer_id, m.viewer_name, m.kind, m.direction, m.text, m.created_at,
         COALESCE(r.remark, '') as viewer_remark
  FROM visitor_messages m
  LEFT JOIN viewer_remarks r ON m.device_id = r.device_id AND m.viewer_id = r.viewer_id
  WHERE (m.device_id = ? OR m.device_id = '__broadcast__')
    AND m.kind IN ('private', 'reply')
    AND (? = '' OR datetime(m.created_at) > datetime(?))
  ORDER BY m.created_at ASC
  LIMIT 500
`);

const getViewerMessageHistory = db.prepare(`
  SELECT id, device_id, viewer_id, viewer_name, kind, direction, text, created_at
  FROM visitor_messages
  WHERE viewer_id = ?
    AND (
      (direction = 'device' AND kind = 'reply')
      OR (direction = 'viewer' AND kind = 'private')
    )
    AND (? = '' OR datetime(created_at) > datetime(?))
  ORDER BY created_at ASC
  LIMIT 100
`);

const getPublicMessagesByWindow = db.prepare(`
  SELECT id, device_id, viewer_id, viewer_name, text, created_at, kind
  FROM visitor_messages
  WHERE (kind = 'public' OR kind = 'public_reply')
    AND created_at >= ?
    AND created_at < ?
  ORDER BY created_at ASC
  LIMIT 200
`);

const getRecentPublicMessages = db.prepare(`
  SELECT id, device_id, viewer_id, viewer_name, text, created_at, kind
  FROM (
    SELECT id, device_id, viewer_id, viewer_name, text, created_at, kind
    FROM visitor_messages
    WHERE (kind = 'public' OR kind = 'public_reply')
      AND datetime(created_at) >= datetime(?)
    ORDER BY datetime(created_at) DESC
    LIMIT 200
  )
  ORDER BY datetime(created_at) ASC
`);

const getMessageTargetDevices = db.prepare(`
  SELECT device_id
  FROM device_states
  WHERE platform <> 'zepp'
  ORDER BY last_seen_at DESC
  LIMIT 20
`);

const getMessageTargetDevice = db.prepare(`
  SELECT device_id
  FROM device_states
  WHERE device_id = ? AND platform <> 'zepp'
  LIMIT 1
`);

export function isViewerBlocked(deviceId: string, viewerId: string): boolean {
  return Boolean(isViewerBlockedStmt.get(deviceId, viewerId));
}

export function blockViewer(deviceId: string, viewerId: string): void {
  blockViewerStmt.run(deviceId, viewerId);
}

export function unblockViewer(deviceId: string, viewerId: string): void {
  unblockViewerStmt.run(deviceId, viewerId);
}

export function recordMessage(
  id: string,
  deviceId: string,
  viewerId: string,
  viewerName: string,
  kind: StoredMessageKind,
  direction: MessageDirection,
  text: string,
  createdAt = new Date().toISOString(),
): boolean {
  const result = insertVisitorMessage.run(id, deviceId, viewerId, viewerName, kind, direction, text, createdAt);
  return result.changes > 0;
}

export function isPublicMessageThread(messageId: string): boolean {
  const row = getVisitorMessageKind.get(messageId) as { kind: string } | null;
  return row?.kind === "public" || row?.kind === "public_reply";
}

export function messageTargetDevices(): MessageTargetDeviceRow[] {
  return getMessageTargetDevices.all() as MessageTargetDeviceRow[];
}

export function hasMessageTargetDevice(deviceId: string): boolean {
  return Boolean(getMessageTargetDevice.get(deviceId));
}

export function deviceMessageHistory(deviceId: string, since: string): unknown[] {
  return getDeviceMessageHistory.all(deviceId, since, since);
}

export function viewerMessageHistory(viewerId: string, since: string): unknown[] {
  return getViewerMessageHistory.all(viewerId, since, since);
}

export function recentPublicMessages(since: string): unknown[] {
  return getRecentPublicMessages.all(since);
}

export function publicMessagesByWindow(startIso: string, endIso: string): unknown[] {
  return getPublicMessagesByWindow.all(startIso, endIso);
}

export function deleteMessageForDevice(messageId: string, deviceId: string): {
  existing: VisitorMessageForDelete | null;
  deleted: boolean;
} {
  const existing = getVisitorMessageForDelete.get(messageId) as VisitorMessageForDelete | null;
  if (!existing) return { existing: null, deleted: false };

  const result = deleteVisitorMessage.run(messageId, deviceId);
  const deleted = result.changes > 0;
  if (deleted) deleteQueuedMessage(messageId);
  return { existing, deleted };
}

export function deleteViewerMessagesForDevice(deviceId: string, viewerId: string): number {
  const result = deleteVisitorMessagesByViewer.run(deviceId, viewerId);
  deleteQueuedMessagesForViewer(deviceId, viewerId);
  return Number(result.changes);
}

export function setViewerRemark(deviceId: string, viewerId: string, remark: string): void {
  upsertViewerRemark.run(deviceId, viewerId, remark);
}
