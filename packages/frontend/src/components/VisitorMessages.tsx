"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DeviceState } from "@/lib/api";
import { getRealtimeUrl } from "@/lib/api";
import { ensureViewerToken, getCachedViewerToken, type TokenStatus } from "@/lib/viewer-token";

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

export default function VisitorMessages({ device }: Props) {
  const [connected, setConnected] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState<"idle" | "pow" | "token" | "connecting">("idle");
  const [privateText, setPrivateText] = useState("");
  const [privateSending, setPrivateSending] = useState(false);
  const [publicText, setPublicText] = useState("");
  const [publicSending, setPublicSending] = useState(false);
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
    let statusTimer: ReturnType<typeof setTimeout> | null = null;

    const showSlowStatus = (status: TokenStatus) => {
      if (statusTimer) clearTimeout(statusTimer);
      statusTimer = setTimeout(() => {
        if (!closed) setLoadingStatus(status);
      }, 350);
    };

    const connect = async () => {
      try {
        const hadCachedToken = Boolean(getCachedViewerToken());
        const identity = await ensureViewerToken(hadCachedToken ? undefined : showSlowStatus);
        if (closed) return;
        if (statusTimer) clearTimeout(statusTimer);
        tokenRef.current = identity.token;
        setViewerId(identity.viewerId);

        setLoadingStatus("connecting");
        const ws = new WebSocket(getRealtimeUrl(identity.token));
        socketRef.current = ws;
        ws.onopen = () => {
          setConnected(true);
          setLoadingStatus("idle");
          setError("");
        };
        ws.onclose = () => {
          setConnected(false);
          setLoadingStatus("idle");
          if (!closed) retry = setTimeout(connect, 3000);
        };
        ws.onerror = () => {
          setConnected(false);
          setLoadingStatus("idle");
        };
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
            } else if (data.type === "public_message" && data.message) {
              const message = data.message;
              if (typeof message.id === "string" && typeof message.text === "string") {
                setPublicLines((prev) => {
                  if (prev.some((line) => line.id === message.id)) return prev;
                  return [...prev, {
                    id: message.id,
                    viewer_name: typeof message.viewer_name === "string" ? message.viewer_name : "",
                    text: message.text,
                    created_at: typeof message.created_at === "string" ? message.created_at : new Date().toISOString(),
                  }];
                });
              }
            }
          } catch (e) {
            // ignore parse errors
          }
        };
      } catch (e) {
        setError(e instanceof Error ? e.message : "\u8fde\u63a5\u5931\u8d25\uff0c\u6b63\u5728\u91cd\u8bd5...");
        if (!closed) retry = setTimeout(connect, 5000);
      }
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (statusTimer) clearTimeout(statusTimer);
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
    if (!connected && device.is_online !== 1) return "对方离线，消息将稍后送达";
    if (!connected) return "实时连接恢复中，私聊会走备用通道";
    return device.is_online === 1 ? "可以发送消息了" : "对方离线，消息将稍后送达";
  }, [connected, device]);

  const updateName = (value: string) => {
    const next = value.slice(0, 32);
    setDisplayName(next);
    localStorage.setItem("live-dashboard-viewer-name", next);
  };

  const sendPublic = async () => {
    const cleaned = publicText.trim();
    if (!cleaned || publicSending) return;
    const id = crypto.randomUUID();
    const optimistic = {
      id,
      viewer_name: displayName.trim(),
      text: cleaned,
      created_at: new Date().toISOString(),
    };
    setPublicText("");
    setPublicLines((prev) => [...prev, optimistic]);
    setPublicSending(true);
    try {
      const identity = await ensureViewerToken();
      tokenRef.current = identity.token;
      setViewerId(identity.viewerId);
      const res = await fetch(`${API_BASE}/api/messages/public`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${identity.token}`,
        },
        body: JSON.stringify({
          message_id: id,
          target_device_id: device?.device_id || "",
          viewer_name: displayName.trim(),
          text: cleaned,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      setError(e instanceof Error ? `公开留言发送失败: ${e.message}` : "公开留言发送失败");
      setPublicLines((prev) => prev.filter((line) => line.id !== id));
      setPublicText(cleaned);
    } finally {
      setPublicSending(false);
    }
  };

  const setPrivateLineStatus = (deviceId: string | undefined, messageId: string, status: string) => {
    setLines((prev) => {
      const next = prev.map((line) => line.id === messageId ? { ...line, status } : line);
      saveHistory(deviceId, next);
      return next;
    });
  };

  const sendPrivate = async () => {
    const cleaned = privateText.trim();
    if (!device || !cleaned || privateSending) return;
    const id = crypto.randomUUID();
    const payload = {
      type: "viewer_message",
      kind: "private",
      message_id: id,
      target_device_id: device.device_id,
      viewer_name: displayName.trim(),
      text: cleaned,
    };
    const line = { id, from: "viewer" as const, text: cleaned, status: "发送中", at: new Date().toISOString() };
    setLines((prev) => {
      const next = [...prev, line];
      saveHistory(device.device_id, next);
      return next;
    });
    setPrivateText("");
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(payload));
        return;
      } catch {
        // Fall through to HTTP fallback.
      }
    }

    setPrivateSending(true);
    try {
      const identity = await ensureViewerToken();
      tokenRef.current = identity.token;
      setViewerId(identity.viewerId);
      const res = await fetch(`${API_BASE}/api/messages/private`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${identity.token}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `HTTP ${res.status}`);
      setPrivateLineStatus(device.device_id, id, typeof data.status === "string" ? data.status : "queued");
    } catch (e) {
      setPrivateLineStatus(device.device_id, id, "failed");
      setError(e instanceof Error ? `私聊发送失败: ${e.message}` : "私聊发送失败");
    } finally {
      setPrivateSending(false);
    }
  };

  const send = (kind: "private" | "public") => {
    if (kind === "public") {
      void sendPublic();
    } else {
      void sendPrivate();
    }
  };

  return (
    <section className="vn-bubble">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
          留言小窗
        </h2>
        <span className="text-[10px] text-[var(--color-text-muted)] flex items-center gap-1">
          {!connected && <span className="inline-block w-2.5 h-2.5 border border-[var(--color-text-muted)] border-t-transparent rounded-full animate-spin" />}
          {statusText}
        </span>
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
        {loadingStatus === "pow" && <div className="text-[10px] text-[var(--color-accent)]">🔐 正在计算工作证明，请稍候...</div>}
        {loadingStatus === "token" && <div className="text-[10px] text-[var(--color-accent)]">🎫 正在获取访客令牌...</div>}
        {loadingStatus === "connecting" && <div className="text-[10px] text-[var(--color-accent)]">🔗 正在连接...</div>}
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
            disabled={publicSending}
            className="flex-1 min-w-0 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none"
            placeholder="写条留言喵~"
          />
          <button onClick={() => send("public")} disabled={publicSending || !publicText.trim()} className="pill-btn px-3 py-2 text-xs disabled:opacity-40">
            {publicSending ? "发送中" : "发布喵!"}
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
            disabled={!device || privateSending}
            className="flex-1 min-w-0 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none"
            placeholder={device ? "悄悄对我说喵~" : "先选一个设备"}
          />
          <button onClick={() => send("private")} disabled={!device || privateSending || !privateText.trim()} className="pill-btn px-3 py-2 text-xs disabled:opacity-40">
            {privateSending ? "发送中" : "发送喵!"}
          </button>
        </div>
      </div>
    </section>
  );
}
