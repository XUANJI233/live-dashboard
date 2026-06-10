import type { DeviceInfo } from "../types";

let tokenMap = new Map<string, DeviceInfo>();
let tokenEnvSignature = "";

loadDeviceTokens();

export function authenticateToken(authHeader: string | null): DeviceInfo | null {
  if (!authHeader) return null;
  loadDeviceTokens();

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  return tokenMap.get(match[1]!) || null;
}

function loadDeviceTokens(): void {
  const entries = Object.entries(process.env)
    .filter(([key, value]) => key.startsWith("DEVICE_TOKEN_") && !!value)
    .sort(([left], [right]) => left.localeCompare(right));
  const signature = entries.map(([key, value]) => `${key}=${value}`).join("\n");
  if (signature === tokenEnvSignature) return;
  tokenEnvSignature = signature;

  const nextTokenMap = new Map<string, DeviceInfo>();
  for (const [key, value] of entries) {
    const parts = value!.split(":");
    if (parts.length >= 4) {
      const [token, device_id, device_name, platform] = [
        parts[0],
        parts[1],
        parts.slice(2, -1).join(":"), // device_name may contain colons
        parts[parts.length - 1],
      ];
      if (
        token &&
        device_id &&
        device_name &&
        (platform === "windows" || platform === "android" || platform === "macos" || platform === "zepp")
      ) {
        nextTokenMap.set(token, { device_id, device_name, platform });
      } else {
        const validPlatforms = "windows / android / macos / zepp";
        if (!platform || !["windows", "android", "macos", "zepp"].includes(platform)) {
          console.warn(`[auth] ${key}: 平台 "${platform}" 无效，必须是 ${validPlatforms}`);
        } else {
          console.warn(`[auth] ${key}: 格式不完整，缺少必要字段`);
        }
      }
    } else {
      console.warn(`[auth] ${key}: 格式错误，需要 4 个部分用 : 分隔`);
      console.warn("[auth] 正确格式: 密钥:设备ID:显示名:平台");
      console.warn("[auth] 示例: openssl rand -hex 16 | xargs -I{} echo \"{}:my-pc:我的电脑:windows\"");
    }
  }

  tokenMap = nextTokenMap;
  if (tokenMap.size === 0) {
    console.warn("[auth] 未配置设备令牌，请设置 DEVICE_TOKEN_1 等环境变量");
    console.warn("[auth] 格式: 密钥:设备ID:显示名:平台 (平台: windows/android/macos/zepp)");
  }
  console.log(`[auth] 已加载 ${tokenMap.size} 个设备令牌`);
}
