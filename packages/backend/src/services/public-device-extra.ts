function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// One public view for /api/current and viewer device_update frames: raw foreground
// titles, installed-app inventories, and web allowlist state (blocked hosts) stay
// behind device-authenticated APIs.
export function publicDeviceExtra(extra: Record<string, unknown>): Record<string, unknown> {
  let publicExtra = extra;
  const foreground = plainObject(extra.foreground);
  if (foreground) {
    const publicForeground = { ...foreground };
    delete publicForeground.title;
    publicExtra = { ...publicExtra, foreground: publicForeground };
  }
  const device = plainObject(extra.device);
  if (device) {
    const publicDevice = { ...device };
    if (Array.isArray(publicDevice.installed_apps)) {
      publicDevice.installed_apps_count = publicDevice.installed_apps.length;
    }
    delete publicDevice.installed_apps;
    delete publicDevice.web_allowlist;
    publicExtra = { ...publicExtra, device: publicDevice };
  }
  return publicExtra;
}
