export function hermesControllerEnabled(): boolean {
  return /^true$/i.test(process.env.HERMES_CONTROLLER_ENABLED || "");
}

export function liveInternalAiEnabled(): boolean {
  return !hermesControllerEnabled();
}
