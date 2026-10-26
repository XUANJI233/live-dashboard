import { createHash } from "node:crypto";
import { storedRequestFingerprint } from "./device-command-ledger";
import type { DeviceCommandRequest } from "./device-control";

/**
 * A caller-supplied request_id makes send_device_commands idempotent: the same request is
 * replayed from the ledger instead of reaching the phone twice, and a different request under
 * the same id is a conflict. Field order in the caller's JSON does not matter.
 */
export function deviceCommandRequestFingerprint(commands: DeviceCommandRequest[]): string {
  const canonical = commands.map((command) => ({
    device_id: command.device_id ?? "",
    freeze_commands: command.freeze_commands ?? [],
    unfreeze_commands: command.unfreeze_commands ?? [],
    vibrate: command.vibrate === true,
    screen_off: command.screen_off === true,
    say: command.say ?? "",
    screenshot: command.screenshot
      ? {
          screenshot_id: command.screenshot.screenshot_id,
          max_width: command.screenshot.max_width,
          jpeg_quality: command.screenshot.jpeg_quality,
        }
      : null,
    expires_in_seconds: command.expires_in_seconds ?? null,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32);
}

export function inspectDeviceCommandRequest(requestId: string, fingerprint: string): "new" | "retry" | "conflict" {
  const stored = storedRequestFingerprint(requestId);
  if (stored === null) return "new";
  // Rows written before fingerprints existed carry "": replay them rather than send twice.
  return stored === "" || stored === fingerprint ? "retry" : "conflict";
}
