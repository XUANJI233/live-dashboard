export type AiJobRunnerResult =
  | { lifecycle: "completed"; value: Record<string, unknown> }
  | { lifecycle: "delegated"; value: Record<string, unknown> };

export type AiJobRunner = () => Promise<AiJobRunnerResult>;

export function completedAiJob(value: Record<string, unknown>): AiJobRunnerResult {
  return { lifecycle: "completed", value };
}

export function delegatedAiJob(value: Record<string, unknown>): AiJobRunnerResult {
  return { lifecycle: "delegated", value };
}
