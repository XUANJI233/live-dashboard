import type { DeviceInfo } from "../types";

export type RealtimeRole = "viewer" | "device";

export interface WsData {
  role: RealtimeRole;
  id: string;
  device?: DeviceInfo;
  deviceToken?: string;
}
