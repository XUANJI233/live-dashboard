import { ensureViewerToken } from "@/lib/viewer-token";
import { getRealtimeUrl } from "@/lib/api";

type MessageHandler = (message: any) => void;
type StateHandler = (connected: boolean) => void;
type RealtimeAckMissReason = "unavailable" | "send_failed" | "timeout" | "closed" | "replaced";

export type RealtimeAckResult =
  | { received: true; status?: string; error?: string }
  | { received: false; reason: RealtimeAckMissReason };

interface AckWaiter {
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: RealtimeAckResult) => void;
}

const messageHandlers = new Set<MessageHandler>();
const stateHandlers = new Set<StateHandler>();
const ackWaiters = new Map<string, AckWaiter>();

const RECONNECT_BASE_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const RECONNECT_JITTER_RATIO = 0.25;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_BASE_DELAY_MS;
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

function completeAckWaiter(messageId: string, result: RealtimeAckResult) {
  const waiter = ackWaiters.get(messageId);
  if (!waiter) return;
  ackWaiters.delete(messageId);
  clearTimeout(waiter.timer);
  waiter.resolve(result);
}

function failPendingAckWaiters(reason: RealtimeAckMissReason) {
  for (const messageId of Array.from(ackWaiters.keys())) {
    completeAckWaiter(messageId, { received: false, reason });
  }
}

function resolveAckMessage(message: any) {
  if (message?.type === "ack" || message?.type === "error") {
    const messageId = typeof message.message_id === "string" ? message.message_id : "";
    if (!messageId) return;
    completeAckWaiter(messageId, {
      received: true,
      status: typeof message.status === "string" ? message.status : undefined,
      error: typeof message.error === "string" ? message.error : undefined,
    });
    return;
  }

  if (message?.type === "viewer_message_sent") {
    const messageId = typeof message.message?.id === "string" ? message.message.id : "";
    if (!messageId) return;
    completeAckWaiter(messageId, {
      received: true,
      status: typeof message.status === "string" ? message.status : undefined,
    });
  }
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
      reconnectDelay = RECONNECT_BASE_DELAY_MS;
      notifyState(true);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        resolveAckMessage(message);
        emitMessage(message);
      } catch {
        // Ignore invalid frames.
      }
    };

    ws.onclose = () => {
      failPendingAckWaiters("closed");
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
  const jitter = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER_RATIO;
  const delay = Math.round(reconnectDelay * jitter);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
    void connect();
  }, delay);
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
  failPendingAckWaiters("closed");
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

export function sendRealtimeWithAck(
  payload: unknown,
  messageId: string,
  timeoutMs = 4_000,
): Promise<RealtimeAckResult> {
  const currentSocket = socket;
  if (!messageId) return Promise.resolve({ received: false, reason: "send_failed" });
  if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ received: false, reason: "unavailable" });
  }

  completeAckWaiter(messageId, { received: false, reason: "replaced" });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      completeAckWaiter(messageId, { received: false, reason: "timeout" });
    }, timeoutMs);
    ackWaiters.set(messageId, { timer, resolve });

    try {
      currentSocket.send(JSON.stringify(payload));
    } catch {
      completeAckWaiter(messageId, { received: false, reason: "send_failed" });
    }
  });
}

export function isRealtimeConnected() {
  return connected;
}
