import { getDeviceContext } from "./device-context";
import { sendDeviceCommands } from "./device-control";
import { awaitCommandResults } from "./device-command-wait";
import { exactPackagePattern } from "./device-command-packages";
import { grantException, refundException } from "./commitments";
import { noteExceptionUnfreeze } from "./commitment-enforcement";

// MCP entry for a time-boxed exception: Live checks every rule holding the package, unfreezes it
// with an exact command, and the enforcement loop re-freezes it once `relock_at` passes. Quota is
// only spent on an exception that actually reached the phone.

export async function requestExceptionUnfreeze(input: {
  device_id: string;
  package_name: string;
  purpose: string;
  minutes: number;
}, now = new Date()): Promise<Record<string, unknown>> {
  if (!getDeviceContext(input.device_id)?.is_online) throw new Error("device_offline");
  const granted = grantException(input, now);
  const summary = {
    ok: true,
    package_name: input.package_name,
    exception_group_id: granted.group_id,
    commitment_ids: granted.commitment_ids,
    relock_at: granted.relock_at,
    exceptions_left_today: granted.exceptions_left_today,
  };
  if (granted.reused) return { ...summary, reused: true };

  const sent = await awaitCommandResults(sendDeviceCommands({
    request_id: `commitment-exception-${crypto.randomUUID()}`,
    created_by: "supervision",
    commands: [{ device_id: input.device_id, unfreeze_commands: [exactPackagePattern(input.package_name)] }],
  }, { bypassCommitments: true }));
  const command = sent.commands[0];
  if (!command || command.delivery.status !== "sent") {
    refundException(granted.group_id);
    throw new Error("exception_not_delivered");
  }
  noteExceptionUnfreeze(input.device_id, input.package_name, command, now);
  return { ...summary, request_id: sent.request_id, results_pending: sent.results_pending, command };
}
