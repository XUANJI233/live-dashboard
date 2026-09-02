import { sendDeviceCommands } from "./device-control";
import { boundedInteger } from "./bounded-integer";
import {
  consumeScreenshot,
  createScreenshotRequest,
  failScreenshotRequest,
  readScreenshot,
  waitForScreenshot,
  type DeviceScreenshotRecord,
} from "./device-screenshot-store";
import {
  cleanIdentifier,
  cleanLooseIdentifier,
  generatedCommandId,
} from "./mcp-contracts";

export interface ScreenshotCaptureResult {
  status: "pending" | "ready" | "failed" | "missing";
  screenshot_id: string;
  command_id: string;
  device_id: string;
  error?: string;
  record?: DeviceScreenshotRecord;
}

export async function captureDeviceScreenshot(input: {
  device_id: string;
  max_width?: number;
  jpeg_quality?: number;
  wait_seconds?: number;
}): Promise<ScreenshotCaptureResult> {
  const deviceId = cleanLooseIdentifier(input.device_id, 160);
  if (!deviceId) return failed("", "", "", "invalid_device_id");
  const screenshotId = `shot_${crypto.randomUUID()}`;
  const commandId = generatedCommandId();
  createScreenshotRequest({ screenshotId, commandId, deviceId });

  const sent = sendDeviceCommands({
    commands: [{
      command_id: commandId,
      device_id: deviceId,
      screenshot: {
        screenshot_id: screenshotId,
        max_width: boundedInteger(input.max_width, 320, 1080, 720),
        jpeg_quality: boundedInteger(input.jpeg_quality, 35, 85, 65),
      },
      expires_in_seconds: 90,
    }],
  });
  const command = sent.commands.find((item) => item.command_id === commandId);
  if (!command || command.delivery.status === "failed" || command.delivery.status === "skipped") {
    const error = command?.result.payload.reason || command?.delivery.reason || "screenshot_command_not_delivered";
    failScreenshotRequest(screenshotId, String(error));
    return failed(screenshotId, commandId, deviceId, String(error));
  }

  const waitMs = boundedInteger(input.wait_seconds, 0, 20, 12) * 1000;
  const record = await waitForScreenshot(screenshotId, waitMs);
  return resultFromRecord(record, screenshotId, commandId, deviceId);
}

export function getDeviceScreenshot(screenshotIdValue: string): ScreenshotCaptureResult {
  const screenshotId = cleanIdentifier(screenshotIdValue);
  if (!screenshotId) return failed("", "", "", "invalid_screenshot_id");
  const current = readScreenshot(screenshotId);
  if (!current) {
    return { status: "missing", screenshot_id: screenshotId, command_id: "", device_id: "" };
  }
  const record = current.status === "ready" ? consumeScreenshot(screenshotId) : current;
  return resultFromRecord(record, screenshotId, current.command_id, current.device_id);
}

export function consumeReadyScreenshot(input: ScreenshotCaptureResult): ScreenshotCaptureResult {
  if (input.status !== "ready" || !input.record) return input;
  const consumed = consumeScreenshot(input.screenshot_id);
  return resultFromRecord(consumed, input.screenshot_id, input.command_id, input.device_id);
}

function resultFromRecord(
  record: DeviceScreenshotRecord | null,
  screenshotId: string,
  commandId: string,
  deviceId: string,
): ScreenshotCaptureResult {
  if (!record) return { status: "missing", screenshot_id: screenshotId, command_id: commandId, device_id: deviceId };
  if (record.status === "failed") return failed(screenshotId, commandId, deviceId, record.error || "screenshot_failed");
  return {
    status: record.status,
    screenshot_id: screenshotId,
    command_id: commandId,
    device_id: deviceId,
    record,
  };
}

function failed(screenshotId: string, commandId: string, deviceId: string, error: string): ScreenshotCaptureResult {
  return {
    status: "failed",
    screenshot_id: screenshotId,
    command_id: commandId,
    device_id: deviceId,
    error,
  };
}
