import { db } from "../db";

const MESSAGE_TTL_MINUTES = 30;

export interface PendingMessageRow {
  id: string;
  viewer_id: string;
  viewer_name: string;
  kind: string;
  text: string;
  payload: string;
  created_at: string;
}

const insertQueuedMessage = db.prepare(`
  INSERT INTO device_messages (id, device_id, viewer_id, text, payload, expires_at)
  VALUES (?, ?, ?, ?, ?, datetime('now', ?))
`);

const getPendingMessages = db.prepare(`
  SELECT dm.id, dm.viewer_id, dm.text, dm.payload, dm.created_at,
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

const markMessageDeliveredStmt = db.prepare(`
  UPDATE device_messages
  SET delivered_at = datetime('now')
  WHERE id = ? AND device_id = ?
`);

const getQueuedMessageDelivery = db.prepare(`
  SELECT delivered_at
  FROM device_messages
  WHERE id = ? AND device_id = ?
  LIMIT 1
`);

const markMessagesDeliveredStmt = db.transaction((deviceId: string, ids: string[]) => {
  for (const id of ids) markMessageDeliveredStmt.run(id, deviceId);
});

const markMessageRepliedStmt = db.prepare(`
  UPDATE device_messages
  SET replied_at = datetime('now')
  WHERE id = ?
`);

const deleteQueuedMessageStmt = db.prepare(`
  DELETE FROM device_messages
  WHERE id = ?
`);

const deleteQueuedMessagesByViewerStmt = db.prepare(`
  DELETE FROM device_messages
  WHERE device_id = ? AND viewer_id = ?
`);

export function queueMessage(deviceId: string, viewerId: string, text: string, messageId: string, payloadText = ""): boolean {
  try {
    const result = insertQueuedMessage.run(
      messageId,
      deviceId,
      viewerId,
      text,
      payloadText,
      `+${MESSAGE_TTL_MINUTES} minutes`,
    );
    return result.changes > 0;
  } catch {
    // Duplicate client-supplied message ids are ignored; the sender still gets an ack.
    return false;
  }
}

export function queuedMessageWasDelivered(messageId: string, deviceId: string): boolean {
  const row = getQueuedMessageDelivery.get(messageId, deviceId) as { delivered_at?: string } | null;
  return Boolean(row?.delivered_at);
}

export function markMessageDelivered(messageId: string, deviceId: string): void {
  markMessageDeliveredStmt.run(messageId, deviceId);
}

export function markMessagesDelivered(deviceId: string, ids: string[]): void {
  markMessagesDeliveredStmt(deviceId, ids);
}

export function markMessageReplied(messageId: string): void {
  markMessageRepliedStmt.run(messageId);
}

export function pendingMessages(deviceId: string): PendingMessageRow[] {
  return getPendingMessages.all(deviceId) as PendingMessageRow[];
}

export function deleteQueuedMessage(messageId: string): void {
  deleteQueuedMessageStmt.run(messageId);
}

export function deleteQueuedMessagesForViewer(deviceId: string, viewerId: string): void {
  deleteQueuedMessagesByViewerStmt.run(deviceId, viewerId);
}
