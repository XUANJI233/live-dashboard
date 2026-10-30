import { getDeviceContext } from "./device-context";
import { sendDeviceCommands } from "./device-control";
import { awaitCommandResults } from "./device-command-wait";
import { grantException } from "./commitments";

// MCP entry for a time-boxed exception: Live checks the rule, quota and length, unfreezes, and
// the enforcement loop re-freezes at `relock_at` without anyone having to remember.

export async function requestExceptionUnfreeze(input: {
  device_id: string;
  package_name: string;
  purpose: string;
  minutes: number;
}, now = new Date()): Promise<Record<string, unknown>> {
  if (!getDeviceContext(input.device_id)?.is_online) throw new Error("device_offline");
  const requestId = `commitment-exception-${crypto.randomUUID()}`;
  const granted = grantException({ ...input, unfreeze_request_id: requestId }, now);
  const sent = await awaitCommandResults(sendDeviceCommands({
    request_id: requestId,
    created_by: "supervision",
    commands: [{ device_id: input.device_id, unfreeze_commands: [input.package_name] }],
  }, { bypassCommitments: true }));
  return {
    ok: true,
    exception_id: granted.exception_id,
    commitment_id: granted.commitment.commitment_id,
    package_name: input.package_name,
    relock_at: granted.relock_at,
    exceptions_left_today: granted.exceptions_left_today,
    request_id: sent.request_id,
    results_pending: sent.results_pending,
    commands: sent.commands,
  };
}
