import { ensureViewerToken } from "@/lib/viewer-token";
import { getRealtimeUrl } from "@/lib/api";

type MessageHandler = (message: any) => void;
type StateHandler = (connected: boolean) => void;

const messageHandlers = new Set<MessageHandler>();
const stateHandlers = new Set<StateHandler>();

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 3_000;
let connected = false;
let connecting = false;

function notifyState(next: boolean) {
  if (connected === next) return;
  connected = next;
  for (const handler of stateHandlers) handler(next);
}

function emitMessage(message: any) {
  for (const handler of messageHandlers) handler(message);
}

async function connect() {
  if (typeof window === "undefined") return;
  if (socket || connecting || messageHandlers.size + stateHandlers.size === 0) return;

  connecting = true;
  try {
    const { token } = await ensureViewerToken();
    if (messageHandlers.size + stateHandlers.size === 0) {
      connecting = false;
      return;
    }

    const ws = new WebSocket(getRealtimeUrl(token));
    socket = ws;

    ws.onopen = () => {
      connecting = false;
      reconnectDelay = 3_000;
      notifyState(true);
    };

    ws.onmessage = (event) => {
      try {
        emitMessage(JSON.parse(event.data));
      } catch {
        // Ignore invalid frames.
      }
    };

    ws.onclose = () => {
      socket = null;
      connecting = false;
      notifyState(false);
      scheduleReconnect();
    };

    ws.onerror = () => {
      notifyState(false);
    };
  } catch {
    connecting = false;
    notifyState(false);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer || messageHandlers.size + stateHandlers.size === 0) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    void connect();
  }, reconnectDelay);
}

function disconnectIfIdle() {
  if (messageHandlers.size + stateHandlers.size > 0) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  connecting = false;
  notifyState(false);
}

export function subscribeRealtime(handler: MessageHandler) {
  messageHandlers.add(handler);
  void connect();
  return () => {
    messageHandlers.delete(handler);
    disconnectIfIdle();
  };
}

export function subscribeRealtimeState(handler: StateHandler) {
  stateHandlers.add(handler);
  handler(connected);
  void connect();
  return () => {
    stateHandlers.delete(handler);
    disconnectIfIdle();
  };
}

export function sendRealtime(payload: unknown): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function isRealtimeConnected() {
  return connected;
}
