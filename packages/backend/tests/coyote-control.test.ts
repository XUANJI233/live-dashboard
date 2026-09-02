import { describe, expect, test } from "bun:test";

describe("Coyote MCP safety contract", () => {
  test("keeps cold starts and adjustments inside the 0xNuller safety bounds", async () => {
    const { normalizeCoyoteCommand } = await import("../src/services/coyote-control");

    expect(normalizeCoyoteCommand({
      action: "start",
      channel: "A",
      strength: 80,
      waveform: "pulse_mid",
    })).toMatchObject({ action: "start", channel: "A", strength: 10 });

    expect(normalizeCoyoteCommand({
      action: "adjust",
      channel: "B",
      delta: -90,
    })).toMatchObject({ action: "adjust", channel: "B", delta: -10 });
  });

  test("stop paths remain available without a remote-control grant", async () => {
    const { coyoteCommandAllowed } = await import("../src/services/coyote-control");
    const deniedState = { online: true, connected: true, remote_control_enabled: false };

    expect(coyoteCommandAllowed("start", deniedState)).toBe(false);
    expect(coyoteCommandAllowed("adjust", deniedState)).toBe(false);
    expect(coyoteCommandAllowed("stop", deniedState)).toBe(true);
    expect(coyoteCommandAllowed("emergency_stop", deniedState)).toBe(true);
  });

  test("rate limits accumulated remote strength changes while leaving stops unlimited", async () => {
    const { coyoteRateLimitAllowed } = await import("../src/services/coyote-control");
    const deviceId = `rate-${crypto.randomUUID()}`;

    expect(coyoteRateLimitAllowed(deviceId, "adjust", 10_000)).toBe(true);
    expect(coyoteRateLimitAllowed(deviceId, "adjust", 10_100)).toBe(true);
    expect(coyoteRateLimitAllowed(deviceId, "adjust", 10_200)).toBe(false);
    expect(coyoteRateLimitAllowed(deviceId, "adjust", 15_100)).toBe(true);
    expect(coyoteRateLimitAllowed(deviceId, "stop", 15_101)).toBe(true);
    expect(coyoteRateLimitAllowed(deviceId, "stop", 15_102)).toBe(true);
  });

  test("routes Coyote commands through the integration socket without occupying the device socket", async () => {
    const { handleAndroidIntegrationWsMessage, executeCoyoteCommand } = await import("../src/services/android-integration-control");
    const { realtimeSocketHub } = await import("../src/services/realtime-socket-hub");
    const deviceId = `integration-${crypto.randomUUID()}`;
    const sent: Record<string, unknown>[] = [];
    const integrationSocket = {
      data: { role: "integration", id: deviceId },
      send(encoded: string) {
        const payload = JSON.parse(encoded) as Record<string, unknown>;
        sent.push(payload);
        if (payload.type === "coyote_command") {
          queueMicrotask(() => handleAndroidIntegrationWsMessage(integrationSocket as never, {
            type: "coyote_command_result",
            v: 1,
            request_id: payload.request_id,
            ok: true,
            status: "applied",
            coyote: {
              available: true,
              connected: true,
              remote_control_enabled: true,
              strength_a: 5,
              strength_b: 0,
              limit_a: 50,
              limit_b: 50,
            },
          }));
        }
      },
      close() {},
      ping() {},
    };
    const primaryDeviceSocket = { data: { role: "device", id: deviceId }, send() {}, close() {}, ping() {} };
    realtimeSocketHub.registerDevice(primaryDeviceSocket as never);
    realtimeSocketHub.registerIntegration(integrationSocket as never);
    handleAndroidIntegrationWsMessage(integrationSocket as never, {
      type: "integration_status",
      v: 1,
      coyote: {
        available: true,
        connected: true,
        remote_control_enabled: true,
        strength_a: 0,
        strength_b: 0,
        limit_a: 50,
        limit_b: 50,
      },
    });

    const requestId = `coyote_${crypto.randomUUID()}`;
    const command = {
      action: "start",
      channel: "A",
      strength: 5,
      waveform: "pulse_mid",
    };
    const [result, retried] = await Promise.all([
      executeCoyoteCommand(deviceId, requestId, command),
      executeCoyoteCommand(deviceId, requestId, command),
    ]);

    expect(realtimeSocketHub.getDeviceSocket(deviceId)).toBe(primaryDeviceSocket as never);
    expect(realtimeSocketHub.getIntegrationSocket(deviceId)).toBe(integrationSocket as never);
    expect(sent.filter((payload) => payload.type === "coyote_command")).toHaveLength(1);
    expect(sent.find((payload) => payload.type === "coyote_command")).toMatchObject({ v: 1, request_id: requestId });
    expect(result).toMatchObject({ ok: true, status: "applied" });
    expect(retried).toMatchObject({ ok: true, status: "applied" });
    const conflict = await executeCoyoteCommand(deviceId, requestId, { ...command, strength: 6 });
    expect(conflict).toMatchObject({ ok: false, status: "conflict", error: "coyote_request_id_conflict" });
    realtimeSocketHub.removeIntegration(integrationSocket as never);
    realtimeSocketHub.removeDevice(primaryDeviceSocket as never);
  });
});
