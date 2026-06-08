import type { DeviceState } from "@/lib/api";

const platformIcons: Record<string, string> = {
  windows: "\u{1F5A5}",
  android: "\u{1F4F1}",
  macos: "\u{1F4BB}",
};

function timeAgo(isoStr: string): string {
  if (!isoStr) return "";
  const ts = new Date(isoStr).getTime();
  if (isNaN(ts)) return "";
  const diff = Date.now() - ts;
  if (diff < 0) return "刚刚";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  return `${Math.floor(hrs / 24)} 天前`;
}

type Props = {
  device: DeviceState;
  selected?: boolean;
  onSelect?: () => void;
};

export default function DeviceCard({ device, selected = false, onSelect }: Props) {
  const isOnline = device.is_online === 1;
  const icon = platformIcons[device.platform] || "\u{1F4BB}";
  const battery = device.extra;
  const hasBattery = battery && typeof battery.battery_percent === "number";

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`glass-sm px-4 py-3 flex items-center gap-3 group w-full text-left ${
        selected ? "ring-2 ring-[var(--color-primary)] bg-[var(--color-primary-soft)]" : ""
      }`}
    >
      {/* Icon */}
      <span className="text-lg opacity-70 group-hover:opacity-100 transition-opacity" aria-hidden="true">
        {icon}
      </span>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{device.device_name}</span>
          {isOnline && hasBattery && (
            <span className="text-[10px] text-[var(--color-text-muted)] tabular-nums font-mono flex-shrink-0">
              {battery.battery_charging ? "\u26A1" : ""}{battery.battery_percent}%
            </span>
          )}
        </div>
        <span className="text-[11px] text-[var(--color-text-muted)]">
          {isOnline ? timeAgo(device.last_seen_at) : "离线"}
          {deviceMeta(device)}
        </span>
      </div>

      {/* Status dot */}
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 transition-colors duration-500 ${
          isOnline ? "bg-[var(--color-emerald)] pulse-dot" : "bg-[var(--color-text-muted)] opacity-30"
        }`}
      />
    </button>
  );
}

function deviceMeta(device: DeviceState): string {
  const parts: string[] = [];
  const extra = device.extra;
  if (extra?.device?.capability_mode === "lsposed" || extra?.device?.uploader === "lsposed") parts.push("LSP");
  if (extra?.device?.network_type) parts.push(extra.device.network_type);
  if (extra?.device?.vpn_active) parts.push("VPN");
  const audio = audioOutputLabel(device);
  if (audio) parts.push(audio);
  if (typeof extra?.device?.ambient_lux === "number") parts.push(`${Math.round(extra.device.ambient_lux)}lx`);
  return parts.length > 0 ? ` · ${parts.join("/")}` : "";
}

function audioOutputLabel(device: DeviceState): string | null {
  const extra = device.extra?.device;
  if (!extra?.audio_output_connected) return null;
  if (extra.audio_output_type === "bluetooth_headset") return "蓝牙耳机";
  if (extra.audio_output_type === "wired_headset") return "有线耳机";
  if (extra.audio_output_type === "usb_audio") return "USB音频";
  if (extra.audio_output_type === "hdmi_audio") return "外接音频";
  return "音频输出";
}
