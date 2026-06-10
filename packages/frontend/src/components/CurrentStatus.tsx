import type { DeviceState } from "@/lib/api";
import { isLspDevice } from "@/lib/device-profile";
import { getAppDescription } from "@/lib/app-descriptions";
import { useConfig } from "@/hooks/useConfig";

interface Props {
  devices: DeviceState[];
}

export default function CurrentStatus({ devices }: Props) {
  const { nsfwFilterEnabled } = useConfig();
  const onlineDevices = devices.filter((d) => d.is_online === 1);
  const activeDevices = onlineDevices.filter(isActivePrimaryDevice).sort((a, b) => {
    const ta = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
    const tb = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0;
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
  const active = activeDevices[0] || onlineDevices.filter((d) => !isWatchDevice(d)).sort((a, b) => {
    const ta = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
    const tb = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0;
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  })[0];

  const isOnline = !!active;
  const activeLines = activeDevices.length > 0 ? activeDevices : (active ? [active] : []);

  const battery = active?.extra;
  const hasBattery = battery && typeof battery.battery_percent === "number";
  const music = active?.extra?.music;

  return (
    <div className={`glass-hero ${isOnline ? "glow-breathe" : ""}`}>
      <div className="px-8 py-8 text-center">
        {isOnline ? (
          <>
            {/* Status label */}
            <div className="flex items-center justify-center gap-2 mb-3">
              <span className="w-2 h-2 rounded-full bg-[var(--color-emerald)] pulse-dot" />
              <span className="text-[11px] font-medium text-[var(--color-emerald)] uppercase tracking-[0.15em]">
                在线
              </span>
            </div>

            {/* Main description */}
            <div className="space-y-2">
              {activeLines.map((device, index) => (
                <div key={device.device_id} className="text-[var(--color-text)]">
                  <p className="text-base sm:text-xl font-medium leading-relaxed">
                    {activeLines.length > 1 ? `${index === 0 ? "在用" : "并在用"}${device.device_name}: ` : ""}
                    {getAppDescription(device.app_name, device.display_title, device.extra?.music, {
                      appId: device.app_id,
                      nsfwFilterEnabled,
                    })}
                  </p>
                  <DeviceMetaLine device={device} />
                </div>
              ))}
            </div>

            {/* Music indicator */}
            {music?.title && (
              <div className="mt-4 flex items-center justify-center gap-2.5">
                <div className="flex items-end gap-[2px] h-4">
                  <div className="music-bar" />
                  <div className="music-bar" />
                  <div className="music-bar" />
                  <div className="music-bar" />
                </div>
                <span className="text-xs text-[var(--color-accent-soft)]">
                  {music.artist ? `${music.artist} — ${music.title}` : music.title}
                </span>
              </div>
            )}

            {/* Meta row */}
            <div className="flex items-center justify-center gap-4 mt-4">
              {hasBattery && (
                <span className="text-[11px] text-[var(--color-text-muted)] tabular-nums">
                  {battery.battery_charging ? "\u26A1" : ""}{battery.battery_percent}%
                </span>
              )}
              {onlineDevices.length > 1 && (
                <span className="text-[11px] text-[var(--color-text-muted)]">
                  {onlineDevices.length} 台设备在线
                </span>
              )}
            </div>
          </>
        ) : (
          <div className="py-4">
            <p className="text-3xl mb-3 opacity-60">( -.-)zzZ</p>
            <p className="text-sm text-[var(--color-text-muted)] font-light">
              Monika 不在线
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function DeviceMetaLine({ device }: { device: DeviceState }) {
  const parts: string[] = [];
  const extra = device.extra;
  if (isLspDevice(device)) {
    parts.push("LSP");
  }
  if (typeof extra?.battery_percent === "number") {
    parts.push(`${extra.battery_charging ? "充电 " : ""}${extra.battery_percent}%`);
  }
  if (extra?.device?.network_type) {
    const cellular = extra.device.cellular_generation ? ` ${extra.device.cellular_generation}` : "";
    parts.push(`${extra.device.network_type}${cellular}`);
  }
  if (extra?.device?.vpn_active) {
    parts.push(extra.device.vpn_name ? `VPN ${extra.device.vpn_name}` : "VPN");
  }
  const audio = audioOutputLabel(device);
  if (audio) parts.push(audio);
  if (typeof extra?.device?.ambient_lux === "number") {
    parts.push(`环境光 ${Math.round(extra.device.ambient_lux)} lx`);
  }
  if (extra?.device?.window_mode && extra.device.window_mode !== "fullscreen") {
    parts.push(extra.device.window_mode);
  }
  if (parts.length === 0) return null;
  return (
    <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
      {parts.join(" · ")}
    </p>
  );
}

function isActivePrimaryDevice(device: DeviceState) {
  if (device.is_online !== 1 || isWatchDevice(device)) return false;
  const extra = device.extra;
  if (extra?.sleeping) return false;
  const combined = `${device.app_id} ${device.app_name}`.toLowerCase();
  if (!combined.trim() || combined.includes("idle") || combined.includes("sleeping")) return false;
  const lastSeen = device.last_seen_at ? Date.parse(device.last_seen_at) : 0;
  if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > 2 * 60_000) return false;
  return true;
}

function isWatchDevice(device: DeviceState) {
  return device.platform === "zepp" || device.extra?.device?.device_kind === "watch";
}

function audioOutputLabel(device: DeviceState): string | null {
  const extra = device.extra?.device;
  if (!extra?.audio_output_connected) return null;
  const type = extra.audio_output_type;
  const label = type === "bluetooth_headset"
    ? "蓝牙耳机"
    : type === "wired_headset"
    ? "有线耳机"
    : type === "usb_audio"
    ? "USB 音频"
    : type === "hdmi_audio"
    ? "外接音频"
    : "音频输出";
  return extra.audio_output_name ? `${label} ${extra.audio_output_name}` : label;
}
