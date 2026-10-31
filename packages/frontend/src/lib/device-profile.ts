import type { DeviceState } from "@/lib/api";

type DeviceProfile = NonNullable<DeviceState["extra"]>["device"] extends infer DeviceExtra
  ? DeviceExtra extends { profile?: infer Profile }
    ? Profile
    : never
  : never;

export function isLspDevice(device: DeviceState): boolean {
  return device.extra?.device?.profile === "android_lsp";
}

export function deviceProfileLabel(device: DeviceState): string | null {
  const profile = device.extra?.device?.profile as DeviceProfile | undefined;
  if (profile === "android_lsp") return "LSP";
  if (profile === "android_normal") return "普通安卓";
  if (profile === "desktop_message") return "桌面消息";
  if (profile === "unsupported") return "不支持控制";
  return null;
}

/** What the device can be told to do, one short name each; null when it reports no capabilities. */
export function deviceCapabilityNames(device: DeviceState): string[] | null {
  const capabilities = device.extra?.device?.capabilities;
  if (!capabilities) return null;
  return [
    capabilities.freeze ? "冻结" : "",
    capabilities.unfreeze ? "解冻" : "",
    capabilities.vibrate ? "震动" : "",
    capabilities.say ? "提醒" : "",
    capabilities.screen_off ? "息屏" : "",
    capabilities.risk_app_monitor ? "风险复核" : "",
    capabilities.app_time_limit ? "应用限时" : "",
  ].filter(Boolean);
}

// How each client keeps reporting while the system saves power, as the clients name it.
const ENERGY_POLICY_LABELS: Record<string, string> = {
  system_server_direct: "系统进程直报",
  app_workmanager: "应用定时上报",
  app_workmanager_root: "应用定时上报（Root）",
  zepp_alarm_single_execution: "闹钟定时唤醒",
  zepp_sleep_30m_alarm: "睡眠时每 30 分钟唤醒",
};

/** A reader's name for a client's energy policy; an unknown code reads with spaces for underscores. */
export function energyPolicyLabel(policy: string): string {
  return ENERGY_POLICY_LABELS[policy] ?? policy.replace(/_/g, " ");
}
