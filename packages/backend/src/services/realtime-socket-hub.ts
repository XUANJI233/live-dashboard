import type { ServerWebSocket } from "bun";
import type { WsData } from "./realtime-types";

const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 35_000;
const MAX_VIEWER_SOCKETS_PER_VIEWER = 4;
const MAX_VIEWER_SOCKETS_TOTAL = 1000;

export function sendJson(ws: ServerWebSocket<WsData>, payload: unknown): void {
  ws.send(JSON.stringify(payload));
}

class RealtimeSocketHub {
  private readonly deviceSockets = new Map<string, ServerWebSocket<WsData>>();
  private readonly viewerSockets = new Map<string, Set<ServerWebSocket<WsData>>>();
  private readonly allViewerSockets = new Set<ServerWebSocket<WsData>>();
  private readonly devicePongTimes = new Map<string, number>();

  constructor() {
    const pingTimer = setInterval(() => {
      const now = Date.now();
      for (const [deviceId, ws] of this.deviceSockets) {
        const lastPong = this.devicePongTimes.get(deviceId) ?? 0;
        if (now - lastPong > PONG_TIMEOUT_MS) {
          ws.close(4001, "pong timeout");
          continue;
        }
        try { ws.ping(); } catch { /* socket may already be closing */ }
      }
    }, PING_INTERVAL_MS);
    pingTimer.unref();
  }

  registerDevice(ws: ServerWebSocket<WsData>): void {
    const previous = this.deviceSockets.get(ws.data.id);
    if (previous && previous !== ws) {
      try { previous.close(4000, "replaced by new device socket"); } catch { /* ignore */ }
    }
    this.deviceSockets.set(ws.data.id, ws);
    this.devicePongTimes.set(ws.data.id, Date.now());
  }

  markDevicePong(ws: ServerWebSocket<WsData>): void {
    this.devicePongTimes.set(ws.data.id, Date.now());
  }

  removeDevice(ws: ServerWebSocket<WsData>): void {
    if (this.deviceSockets.get(ws.data.id) === ws) this.deviceSockets.delete(ws.data.id);
    this.devicePongTimes.delete(ws.data.id);
  }

  removeDeviceById(deviceId: string): void {
    this.deviceSockets.delete(deviceId);
    this.devicePongTimes.delete(deviceId);
  }

  closeDevice(deviceId: string, code: number, reason: string): void {
    const ws = this.deviceSockets.get(deviceId);
    if (ws) {
      try { ws.close(code, reason); } catch { /* ignore */ }
      this.deviceSockets.delete(deviceId);
    }
    this.devicePongTimes.delete(deviceId);
  }

  getDeviceSocket(deviceId: string): ServerWebSocket<WsData> | undefined {
    return this.deviceSockets.get(deviceId);
  }

  onlineMessageDeviceIds(): string[] {
    const ids: string[] = [];
    for (const [id, ws] of this.deviceSockets) {
      if (ws.data.device?.platform !== "zepp") ids.push(id);
    }
    return ids;
  }

  onlineDeviceSupportsMessages(deviceId: string): boolean | null {
    const socketDevice = this.deviceSockets.get(deviceId)?.data.device;
    return socketDevice ? socketDevice.platform !== "zepp" : null;
  }

  broadcastDevicePayload(payload: unknown, options: { messageCapableOnly?: boolean } = {}): void {
    const encoded = JSON.stringify(payload);
    for (const ws of this.deviceSockets.values()) {
      if (options.messageCapableOnly === true && ws.data.device?.platform === "zepp") continue;
      this.trySendEncoded(ws, encoded);
    }
  }

  registerViewer(viewerId: string, ws: ServerWebSocket<WsData>): void {
    const sockets = this.viewerSockets.get(viewerId) ?? new Set<ServerWebSocket<WsData>>();
    if (sockets.size >= MAX_VIEWER_SOCKETS_PER_VIEWER) {
      const oldest = sockets.values().next().value as ServerWebSocket<WsData> | undefined;
      if (oldest) {
        sockets.delete(oldest);
        this.allViewerSockets.delete(oldest);
        try { oldest.close(1013, "viewer socket limit"); } catch { /* ignore */ }
      }
    }
    sockets.add(ws);
    this.allViewerSockets.add(ws);
    this.viewerSockets.set(viewerId, sockets);
  }

  removeViewer(viewerId: string, ws: ServerWebSocket<WsData>): void {
    const sockets = this.viewerSockets.get(viewerId);
    this.allViewerSockets.delete(ws);
    if (!sockets) return;
    sockets.delete(ws);
    if (sockets.size === 0) {
      this.viewerSockets.delete(viewerId);
    }
  }

  viewerSocketCount(): number {
    return this.allViewerSockets.size;
  }

  viewerSocketLimitReached(): boolean {
    return this.viewerSocketCount() >= MAX_VIEWER_SOCKETS_TOTAL;
  }

  sendToViewer(viewerId: string, payload: unknown): number {
    const sockets = this.viewerSockets.get(viewerId);
    if (!sockets || sockets.size === 0) return 0;
    return this.sendPayloadToSockets(sockets, payload);
  }

  broadcastViewerPayload(payload: unknown): number {
    return this.sendPayloadToSockets(this.allViewerSockets, payload);
  }

  private sendPayloadToSockets(sockets: Iterable<ServerWebSocket<WsData>>, payload: unknown): number {
    const encoded = JSON.stringify(payload);
    let delivered = 0;
    for (const ws of sockets) {
      if (this.trySendEncoded(ws, encoded)) delivered += 1;
    }
    return delivered;
  }

  private trySendEncoded(ws: ServerWebSocket<WsData>, encoded: string): boolean {
    try {
      ws.send(encoded);
      return true;
    } catch {
      // Close callbacks, polling fallback, or HTTP fallback cover missed transient sends.
      return false;
    }
  }
}

export const realtimeSocketHub = new RealtimeSocketHub();
