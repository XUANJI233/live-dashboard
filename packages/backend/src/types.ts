export interface DeviceInfo {
  device_id: string;
  device_name: string;
  platform: "windows" | "android" | "macos" | "zepp";
}

export interface ReportPayload {
  app_id: string;
  window_title?: string;
  timestamp?: string;
  extra?: {
    battery_percent?: number;
    battery_charging?: boolean;
    sleeping?: boolean;
    device?: {
      network_connected?: boolean;
      network_type?: string;
      cellular_generation?: string;
      vpn_active?: boolean;
      vpn_name?: string;
      profile?: "android_lsp" | "android_normal" | "desktop_message";
      capabilities?: {
        freeze?: boolean;
        unfreeze?: boolean;
        vibrate?: boolean;
        screen_off?: boolean;
        say?: boolean;
        risk_app_monitor?: boolean;
        app_time_limit?: boolean;
      };
      last_sample_at?: string;
      relay_mode?: string;
      energy_policy?: string;
      min_interval_ms?: number;
      offline_timeout_minutes?: number;
      device_kind?: string;
      window_mode?: string;
      heartbeat_only?: boolean;
      audio_output_connected?: boolean;
      audio_output_type?: string;
      audio_output_name?: string;
      ambient_lux?: number;
    };
    location?: {
      latitude?: number;
      longitude?: number;
      accuracy_m?: number;
      provider?: string;
      recorded_at?: string;
    };
    foreground?: {
      package_name?: string;
      app_name?: string;
      activity?: string;
      title?: string;
      source?: "normal" | "root" | "lsposed" | "accessibility" | "notification";
      confidence?: number;
    };
    media?: {
      playing?: boolean;
      title?: string;
      artist?: string;
      app?: string;
      package_name?: string;
      state?: string;
      source?: "normal" | "root" | "lsposed" | "accessibility" | "notification";
    };
    music?: {
      title?: string;
      artist?: string;
      app?: string;
    };
  };
}

export interface ActivityRecord {
  id: number;
  device_id: string;
  device_name: string;
  platform: string;
  app_id: string;
  app_name: string;
  window_title: string;
  display_title: string;
  extra?: string;
  started_at: string;
  created_at: string;
}

export interface DeviceState {
  device_id: string;
  device_name: string;
  platform: string;
  app_id: string;
  app_name: string;
  window_title: string;
  display_title: string;
  last_seen_at: string;
  is_online: number;
  extra: string; // JSON string
}

export interface TimelineSegment {
  app_name: string;
  app_id: string;
  display_title: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
  duration_minutes: number;
  device_id: string;
  device_name: string;
  extra?: TimelineSegmentExtra;
}

export interface TimelineSegmentExtra {
  foreground?: {
    package_name?: string;
    app_name?: string;
    activity?: string;
    source?: string;
    confidence?: number;
  };
  media?: {
    playing?: boolean;
    title?: string;
    artist?: string;
    app?: string;
    package_name?: string;
    state?: string;
    source?: string;
  };
  music?: {
    title?: string;
    artist?: string;
    app?: string;
  };
  device?: {
    profile?: string;
    window_mode?: string;
    heartbeat_only?: boolean;
    audio_output_connected?: boolean;
    audio_output_type?: string;
    audio_output_name?: string;
    ambient_lux?: number;
  };
}

export interface HealthRecord {
  device_id: string;
  type: string;
  value: number;
  unit: string;
  recorded_at: string;
  end_time: string;
}

export interface LocationRecord {
  device_id: string;
  latitude: number;
  longitude: number;
  accuracy_m: number | null;
  provider: string;
  recorded_at: string;
}
