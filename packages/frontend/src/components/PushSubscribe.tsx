"use client";

import { useEffect, useState } from "react";
import { ensureViewerToken } from "@/lib/viewer-token";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

function urlB64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const len = rawData.length;
  const bytes = new Uint8Array(new ArrayBuffer(len));
  for (let i = 0; i < len; i++) bytes[i] = rawData.charCodeAt(i);
  return bytes;
}

export default function PushSubscribe() {
  const [status, setStatus] = useState<"loading" | "denied" | "subscribed" | "unsubscribed" | "unsupported">("loading");

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setStatus("unsupported");
      return;
    }

    navigator.serviceWorker.ready.then((reg) => {
      reg.pushManager.getSubscription().then((sub) => {
        setStatus(sub ? "subscribed" : "unsubscribed");
      });
    }).catch(() => setStatus("unsupported"));
  }, []);

  const toggle = async () => {
    if (status === "subscribed") {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await sub.unsubscribe();
        try {
          const { token } = await ensureViewerToken();
          await fetch(`${API_BASE}/api/push/unsubscribe`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          });
        } catch {}
      }
      setStatus("unsubscribed");
    } else {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setStatus("denied");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const keyRes = await fetch(`${API_BASE}/api/push/vapid-public-key`);
      const { publicKey } = await keyRes.json();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(publicKey),
      });
      const { token } = await ensureViewerToken();
      await fetch(`${API_BASE}/api/push/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(sub.toJSON()),
      });
      setStatus("subscribed");
    }
  };

  if (status === "unsupported" || status === "loading") return null;

  return (
    <button
      type="button"
      onClick={toggle}
      className="pill-btn px-1.5 py-0.5 text-[10px]"
      title={status === "subscribed" ? "关闭推送通知" : status === "denied" ? "通知权限被拒绝" : "开启回复推送通知"}
    >
      {status === "subscribed" ? "🔔" : status === "denied" ? "🔕" : "🔔+"}
      <span className="ml-1">{status === "subscribed" ? "推送开" : status === "denied" ? "已拒绝" : "推送"}</span>
    </button>
  );
}
