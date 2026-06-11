namespace LiveDashboardAgent.Services;

public static class DesktopDeviceProfile
{
    public const string Profile = "desktop_message";

    public static Dictionary<string, object> WithCapabilities(Dictionary<string, object>? extra = null)
    {
        var payload = extra is null
            ? new Dictionary<string, object>(StringComparer.Ordinal)
            : new Dictionary<string, object>(extra, StringComparer.Ordinal);

        var device = payload.TryGetValue("device", out var existing) &&
            existing is Dictionary<string, object> existingDevice
                ? new Dictionary<string, object>(existingDevice, StringComparer.Ordinal)
                : new Dictionary<string, object>(StringComparer.Ordinal);

        device["profile"] = Profile;
        device["capabilities"] = new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["freeze"] = false,
            ["unfreeze"] = false,
            ["vibrate"] = false,
            ["screen_off"] = false,
            ["say"] = true,
            ["risk_app_monitor"] = false,
            ["app_time_limit"] = false,
        };
        device["device_kind"] = "windows";
        device["last_sample_at"] = DateTimeOffset.UtcNow.ToString("O");
        payload["device"] = device;
        return payload;
    }
}
