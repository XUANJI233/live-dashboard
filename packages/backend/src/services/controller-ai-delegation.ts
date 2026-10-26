import type { DeviceInfo } from "../types";
import { createHash } from "node:crypto";
import { completedAiJob, delegatedAiJob, type AiJobRunnerResult } from "./ai-job-runner";
import {
  controllerEventDelivered,
  controllerEventState,
  enqueueControllerEvent,
  flushControllerEvents,
} from "./controller-event-outbox";
import {
  CONTROLLER_EVENT_SCHEMA,
  type ControllerEvent,
} from "./controller-webhook";
import { cleanIdentifier } from "./mcp-contracts";

export type ControllerAiJobKind =
  | "daily_summary"
  | "weekly_summary"
  | "ai_config_test"
  | "supervision_rules_refresh"
  | "supervision_check";

export async function delegateAiJobToHermes(input: {
  requestId: string;
  kind: ControllerAiJobKind;
  payload: Record<string, unknown>;
  device: DeviceInfo;
}): Promise<AiJobRunnerResult> {
  const kind = input.kind;
  if (kind === "ai_config_test") {
    return completedAiJob({
      ok: true,
      delegated: false,
      managed_by: "hermes",
      provider_test_skipped: true,
      reason: "Live model configuration is inactive while Hermes owns AI work",
    });
  }

  const event = controllerAiEvent({ ...input, kind });
  // A delivered or dead-lettered request id is settled; a resubmission needs a fresh event.
  const prior = controllerEventState(event.event_id);
  if (prior === "delivered" || prior === "dead") {
    event.event_id = controllerAiRetryEventId(input.requestId);
  }
  if (enqueueControllerEvent(event) === "invalid") {
    throw Object.assign(new Error("Failed to enqueue Hermes AI request"), {
      code: "HERMES_AI_REQUEST_INVALID",
    });
  }
  const flush = await flushControllerEvents(new Date(event.occurred_at));
  const accepted = flush.delivered_ids.includes(event.event_id)
    || controllerEventDelivered(event.event_id);
  return delegatedAiJob({
    ok: true,
    delegated: true,
    managed_by: "hermes",
    event_id: event.event_id,
    delivery_status: accepted ? "accepted" : "pending",
  });
}

function controllerAiEvent(input: {
  requestId: string;
  kind: Exclude<ControllerAiJobKind, "ai_config_test">;
  payload: Record<string, unknown>;
  device: DeviceInfo;
}): ControllerEvent {
  const requestId = cleanIdentifier(input.requestId);
  const deviceId = cleanIdentifier(input.device.device_id);
  if (!requestId || !deviceId) throw new Error("invalid_controller_ai_request");
  const occurredAt = new Date().toISOString();
  const eventId = controllerAiEventId(requestId);
  return {
    schema: CONTROLLER_EVENT_SCHEMA,
    v: 1,
    event_id: eventId,
    event_type: "ai.work_requested",
    occurred_at: occurredAt,
    source: "client",
    device_ids: [deviceId],
    reason_codes: [input.kind],
    ai_request: {
      request_id: requestId,
      kind: input.kind,
      payload: input.payload,
    },
  };
}

function controllerAiEventId(requestId: string): string {
  const direct = `ai-request:${requestId}`;
  if (direct.length <= 160) return direct;
  return `ai-request:${createHash("sha256").update(requestId).digest("hex").slice(0, 40)}`;
}

function controllerAiRetryEventId(requestId: string): string {
  const bucket = Math.floor(Date.now() / (5 * 60_000));
  const digest = createHash("sha256").update(requestId).digest("hex").slice(0, 24);
  return `ai-request-retry:${bucket}:${digest}`;
}
