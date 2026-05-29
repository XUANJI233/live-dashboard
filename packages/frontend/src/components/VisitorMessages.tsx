"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import FingerprintJS from "@fingerprintjs/fingerprintjs";
import type { DeviceState } from "@/lib/api";
import { getRealtimeUrl } from "@/lib/api";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

interface Props {
  device?: DeviceState;
}

interface ChatLine {
  id: string;
  from: "viewer" | "device" | "system";
  text: string;
  status?: string;
  at?: string;
}

interface PublicLine {
  id: string;
  viewer_name?: string;
  text: string;
  created_at: string;
}

// FingerprintJS-based fingerprint (Canvas, WebGL, Audio, Fonts, etc.)
let fpPromise: Promise<string> | null = null;
function fingerprint(): Promise<string> {
  if (!fpPromise) {
    fpPromise = FingerprintJS.load()
      .then(fp => fp.get())
      .then(result => result.visitorId);
  }
  return fpPromise;
}

function currentMessageSlot() {
  const date = new Date();
  const roundedMinute = Math.floor(date.getUTCMinutes() / 10) * 10;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(roundedMinute).padStart(2, "0");
  return `${year}${month}${day}${hour}${minute}`;
}

function historyKey(deviceId?: string) {
  return `live-dashboard-private-history-${deviceId || "none"}`;
}

function loadHistory(deviceId?: string): ChatLine[] {
  try {
    return JSON.parse(localStorage.getItem(historyKey(deviceId)) || "[]");
  } catch {
    return [];
  }
}

function saveHistory(deviceId: string | undefined, lines: ChatLine[]) {
  localStorage.setItem(historyKey(deviceId), JSON.stringify(lines.slice(-80)));
}

function messageStatusText(status?: string) {
  if (!status) return "";
  const map: Record<string, string> = {
    sending: "发送中",
    sent: "已发送",
    delivered: "已送达",
    queued: "已排队",
    failed: "发送失败",
    blocked: "已阻止",
  };
  return map[status] || status;
}

async function ensureViewerToken(): Promise<{ token: string; viewerId: string }> {
  const stored = localStorage.getItem("live-dashboard-viewer-token");
  const storedId = localStorage.getItem("live-dashboard-viewer-id");
  const storedExp = Number(localStorage.getItem("live-dashboard-viewer-token-exp") || 0);
  if (stored && storedId && Date.now() < storedExp - 60_000) {
    return { token: stored, viewerId: storedId };
  }

  const res = await fetch(`${API_BASE}/api/token/issue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprint: await fingerprint() }),
  });
  if (!res.ok) throw new Error("访客令牌领取失败");
  const data = await res.json();
  localStorage.setItem("live-dashboard-viewer-token", data.token);
  localStorage.setItem("live-dashboard-viewer-id", data.viewer_id);
  localStorage.setItem("live-dashboard-viewer-token-exp", String(Date.now() + Number(data.expires_in || 3600) * 1000));
  return { token: data.token, viewerId: data.viewer_id };
}

export default function VisitorMessages({ device }: Props) {
  const [connected, setConnected] = useState(false);
  const [privateText, setPrivateText] = useState("");
  const [publicText, setPublicText] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [publicLines, setPublicLines] = useState<PublicLine[]>([]);
  const [viewerId, setViewerId] = useState("");
  const [error, setError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const tokenRef = useRef("");

  useEffect(() => {
    setDisplayName(localStorage.getItem("live-dashboard-viewer-name") || "");
  }, []);

  useEffect(() => {
    setLines(loadHistory(device?.device_id));
  }, [device?.device_id]);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      try {
        const identity = await ensureViewerToken();
        if (closed) return;
        tokenRef.current = identity.token;
        setViewerId(identity.viewerId);

        const ws = new WebSocket(getRealtimeUrl(identity.token));
        socketRef.current = ws;
        ws.onopen = () => {
          setConnected(true);
          setError("");
        };
        ws.onclose = () => {
          setConnected(false);
          if (!closed) retry = setTimeout(connect, 3000);
        };
        ws.onerror = () => setConnected(false);
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "ack" && data.message_id) {
              const rawStatus = typeof data.status === "string" ? data.status : "unknown";
              setLines((prev) => {
                const next = prev.map((line) =>
                  line.id === data.message_id ? { ...line, status: rawStatus } : line
                );
                saveHistory(device?.device_id, next);
                return next;
              });
            } else if (data.type === "device_reply") {
              const line = {
                id: data.message_id || crypto.randomUUID(),
                from: "device" as const,
                text: typeof data.text === "string" ? data.text : "",
                at: data.created_at,
              };
              setLines((prev) => {
                const next = [...prev, line];
                saveHistory(device?.device_id, next);
                return next;
              });
            } else if (data.type === "error") {
              setLines((prev) => [...prev, {
                id: crypto.randomUUID(),
                from: "system",
                text: typeof data.error === "string" ? data.error : "消息未送达，请稍后重试。",
              }]);
            }
          } catch {
            // Ignore malformed realtime frames.
          }
        };
      } catch (e) {
        setError(e instanceof Error ? e.message : "暂时无法获取访客令牌");
        if (!closed) retry = setTimeout(connect, 5000);
      }
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socketRef.current?.close();
    };
  }, [device?.device_id]);

  useEffect(() => {
    let stopped = false;
    const loadPublic = async () => {
      try {
        const identity = await ensureViewerToken();
        const url = `${API_BASE}/api/messages/public?slot=${currentMessageSlot()}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${identity.token}` } });
        if (!res.ok || stopped) return;
        const data = await res.json();
        setPublicLines(Array.isArray(data.messages) ? data.messages : []);
      } catch {
        // Public board is best-effort for visitors.
      }
    };
    loadPublic();
    const timer = setInterval(loadPublic, 30_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  const statusText = useMemo(() => {
    if (!device) return "尚未选择目标设备";
    if (!connected) return "连接中...";
    return device.is_online === 1 ? "可以发送消息了" : "对方离线，消息将稍后送达";
  }, [connected, device]);

  const updateName = (value: string) => {
    const next = value.slice(0, 32);
    setDisplayName(next);
    localStorage.setItem("live-dashboard-viewer-name", next);
  };

  const send = (kind: "private" | "public") => {
    const source = kind === "public" ? publicText : privateText;
    const cleaned = source.trim();
    if (!device || !cleaned || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    const id = crypto.randomUUID();
    socketRef.current.send(JSON.stringify({
      type: "viewer_message",
      kind,
      message_id: id,
      target_device_id: device.device_id,
      viewer_name: displayName.trim(),
      text: cleaned,
    }));
    const line = { id, from: "viewer" as const, text: cleaned, status: "发送中", at: new Date().toISOString() };
    if (kind === "private") {
      setLines((prev) => {
        const next = [...prev, line];
        saveHistory(device.device_id, next);
        return next;
      });
      setPrivateText("");
    } else {
      setPublicLines((prev) => [...prev, {
        id,
        viewer_name: displayName.trim(),
        text: cleaned,
        created_at: new Date().toISOString(),
      }]);
      setPublicText("");
    }
  };

  return (
    <section className="vn-bubble">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
          留言小窗
        </h2>
        <span className="text-[10px] text-[var(--color-text-muted)]">{statusText}</span>
      </div>

      <div className="grid gap-2 mb-3">
        <input
          value={displayName}
          onChange={(e) => updateName(e.target.value)}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none"
          placeholder="怎么称呼喵？"
        />
        {viewerId && <div className="text-[10px] text-[var(--color-text-muted)]">你的访客牌：{viewerId}</div>}
        {error && <div className="text-[10px] text-red-400">{error}</div>}
      </div>

      <div className="mb-4">
        <div className="mb-2 text-xs font-semibold text-[var(--color-text-muted)]">公开小留言板</div>
        <div className="mb-2 max-h-44 overflow-auto space-y-1 text-xs">
          {publicLines.slice(-12).map((line) => (
            <div key={line.id} className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1">
              <span className="font-semibold">{line.viewer_name || "害羞访客"}</span>
              <span className="ml-2 text-[var(--color-text-muted)]">{new Date(line.created_at).toLocaleTimeString()}</span>
              <div>{line.text}</div>
            </div>
          ))}
          {publicLines.length === 0 && <div className="text-[var(--color-text-muted)]">这里还空着喵~</div>}
        </div>
        <div className="flex gap-2">
          <input
            value={publicText}
            onChange={(e) => setPublicText(e.target.value.slice(0, 500))}
            onKeyDown={(e) => { if (e.key === "Enter") send("public"); }}
            disabled={!device || !connected}
            className="flex-1 min-w-0 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none"
            placeholder="写条留言喵~"
          />
          <button onClick={() => send("public")} disabled={!device || !connected || !publicText.trim()} className="pill-btn px-3 py-2 text-xs disabled:opacity-40">
            发布喵!
          </button>
        </div>
      </div>

      <div>
        <div className="mb-2 text-xs font-semibold text-[var(--color-text-muted)]">悄悄话</div>
        {lines.length > 0 && (
          <div className="mb-3 max-h-40 overflow-auto space-y-1 text-xs">
            {lines.slice(-10).map((line) => (
              <div key={line.id} className={line.from === "viewer" ? "text-right" : line.from === "device" ? "text-left" : "text-center text-[var(--color-text-muted)]"}>
                <span className="inline-block max-w-full rounded px-2 py-1 bg-[var(--color-surface)] border border-[var(--color-border)]">
                  {line.text}
                  {line.status && <span className="ml-2 text-[10px] text-[var(--color-text-muted)]">{messageStatusText(line.status)}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            value={privateText}
            onChange={(e) => setPrivateText(e.target.value.slice(0, 500))}
            onKeyDown={(e) => { if (e.key === "Enter") send("private"); }}
            disabled={!device || !connected}
            className="flex-1 min-w-0 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none"
            placeholder={device ? "悄悄对我说喵~" : "先选一个设备"}
          />
          <button onClick={() => send("private")} disabled={!device || !connected || !privateText.trim()} className="pill-btn px-3 py-2 text-xs disabled:opacity-40">
            发送喵!
          </button>
        </div>
      </div>
    </section>
  );
}
