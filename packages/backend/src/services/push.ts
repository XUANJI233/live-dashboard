import webpush from "web-push";
import { db, metaGet, metaSet } from "../db";

// ── VAPID keys (DB-persisted, survives container restarts) ──
let _vapid: { publicKey: string; privateKey: string } | null = null;

export function getVapidKeys(): { publicKey: string; privateKey: string } {
  if (_vapid) return _vapid;
  const stored = metaGet("vapid_keys");
  if (stored) {
    _vapid = JSON.parse(stored);
    return _vapid!;
  }
  _vapid = webpush.generateVAPIDKeys();
  metaSet("vapid_keys", JSON.stringify(_vapid));
  console.log("[push] Generated new VAPID key pair");
  return _vapid;
}

const vapid = getVapidKeys();
webpush.setVapidDetails("mailto:admin@live-dashboard.local", vapid.publicKey, vapid.privateKey);

// ── Subscription management ──
const upsertSub = db.prepare(`INSERT INTO push_subscriptions (viewer_id, endpoint, p256dh, auth, updated_at) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(viewer_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth, updated_at = datetime('now')`);
const getSub = db.prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE viewer_id = ?`);
const delSub = db.prepare(`DELETE FROM push_subscriptions WHERE viewer_id = ?`);

export function saveSubscription(viewerId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  upsertSub.run(viewerId, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
}
export function removeSubscription(viewerId: string) { delSub.run(viewerId); }
export function getSubscriber(viewerId: string) {
  return getSub.get(viewerId) as { endpoint: string; p256dh: string; auth: string } | null;
}

export async function sendPush(viewerId: string, payload: { title: string; body: string; icon?: string; url?: string }): Promise<boolean> {
  const sub = getSubscriber(viewerId);
  if (!sub) return false;
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      {
        TTL: 3600,              // 1 hour — chat notifications are time-sensitive
        urgency: "high",         // deliver immediately
        topic: viewerId.slice(0, 32), // coalesce multiple notifications for same viewer
      },
    );
    return true;
  } catch (e: any) {
    if (e?.statusCode === 410 || e?.statusCode === 404) {
      console.log("[push] Subscription expired, removing:", viewerId);
      removeSubscription(viewerId);
    } else {
      console.error("[push] Failed for viewer", viewerId, ":", e?.statusCode, e?.body || e?.message || e);
    }
    return false;
  }
}
