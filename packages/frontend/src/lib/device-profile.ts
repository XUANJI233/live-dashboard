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

export function deviceCapabilitiesLabel(device: DeviceState): string | null {
  const capabilities = device.extra?.device?.capabilities;
  if (!capabilities) return null;
  const parts = [
    capabilities.freeze ? "冻结" : "",
    capabilities.unfreeze ? "解冻" : "",
    capabilities.vibrate ? "震动" : "",
    capabilities.say ? "提醒" : "",
    capabilities.screen_off ? "息屏" : "",
    capabilities.risk_app_monitor ? "风险复核" : "",
    capabilities.app_time_limit ? "应用限时" : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("/") : "无控制能力";
}
