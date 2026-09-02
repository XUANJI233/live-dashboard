const MAX_WAITERS = 100;

interface PendingResult {
  deviceId: string;
  kind: "coyote" | "accounting";
  resolve: (value: Record<string, unknown>) => void;
  promise: Promise<Record<string, unknown>>;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingResult>();

export function waitForAndroidIntegrationResult(
  requestId: string,
  deviceId: string,
  kind: PendingResult["kind"],
  timeoutMs: number,
  send: () => void,
): Promise<Record<string, unknown>> {
  const existing = pending.get(requestId);
  if (existing) {
    return existing.deviceId === deviceId && existing.kind === kind
      ? existing.promise
      : Promise.resolve({ ok: false, status: "conflict", error: "integration_request_id_conflict" });
  }
  if (pending.size >= MAX_WAITERS) {
    return Promise.resolve({ ok: false, status: "busy", error: "integration_waiter_limit" });
  }
  let resolveResult: (value: Record<string, unknown>) => void = () => undefined;
  const promise = new Promise<Record<string, unknown>>((resolve) => {
    resolveResult = resolve;
  });
  const timer = setTimeout(() => {
    pending.delete(requestId);
    resolveResult({ ok: false, status: "timeout", error: "integration_result_timeout" });
  }, timeoutMs);
  timer.unref?.();
  pending.set(requestId, { deviceId, kind, resolve: resolveResult, promise, timer });
  try {
    send();
  } catch {
    clearTimeout(timer);
    pending.delete(requestId);
    resolveResult({ ok: false, status: "failed", error: "integration_send_failed" });
  }
  return promise;
}

export function settleAndroidIntegrationResult(
  deviceId: string,
  requestId: string,
  kind: PendingResult["kind"],
  value: Record<string, unknown>,
): void {
  const waiter = pending.get(requestId);
  if (!waiter || waiter.deviceId !== deviceId || waiter.kind !== kind) return;
  clearTimeout(waiter.timer);
  pending.delete(requestId);
  waiter.resolve(value);
}
