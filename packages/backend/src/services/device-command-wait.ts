import { getCommandStatuses } from "./device-command-ledger";

// An online Android LSP phone answers within about a second, so a controller tool call waits that
// long for the result instead of spending another model turn on get_command_status.

const DEFAULT_WAIT_MS = 3_000;
const POLL_MS = 150;

type CommandStatus = ReturnType<typeof getCommandStatuses>["commands"][number];

export async function awaitCommandResults<T extends { commands: CommandStatus[] }>(
  sent: T,
  waitMs = DEFAULT_WAIT_MS,
): Promise<T & { results_pending: boolean }> {
  const deadline = Date.now() + waitMs;
  let commands = sent.commands;
  while (commands.some(awaitingResult) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    commands = commands.map((command) => (
      awaitingResult(command) ? getCommandStatuses({ commandId: command.command_id }).commands[0] ?? command : command
    ));
  }
  return { ...sent, commands, results_pending: commands.some(awaitingResult) };
}

function awaitingResult(command: CommandStatus): boolean {
  // Only a delivered command can still answer; queued ones wait for the device to reconnect.
  return command.delivery.status === "sent" && command.result.status === "unknown";
}
