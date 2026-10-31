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

export type DeviceCapability = { label: string; hint: string };

// The card's playful name for each capability, with its plain name for hover.
const CAPABILITY_NAMES: Array<[string, DeviceCapability]> = [
  ["freeze", { label: "❄️ 冻住它", hint: "冻结" }],
  ["unfreeze", { label: "🌸 解冻啦", hint: "解冻" }],
  ["vibrate", { label: "📳 嗡嗡嗡", hint: "震动" }],
  ["say", { label: "🔔 叮咚叮咚", hint: "提醒" }],
  ["screen_off", { label: "🌙 啪嗒熄灯", hint: "息屏" }],
  ["risk_app_monitor", { label: "👀 盯着你哦", hint: "风险复核" }],
  ["app_time_limit", { label: "⏳ 沙漏计时", hint: "应用限时" }],
];

/** What the device can be told to do; null when it reports no capabilities. */
export function deviceCapabilityNames(device: DeviceState): DeviceCapability[] | null {
  const capabilities = device.extra?.device?.capabilities as Record<string, unknown> | undefined;
  if (!capabilities) return null;
  return CAPABILITY_NAMES.filter(([key]) => capabilities[key]).map(([, name]) => name);
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
