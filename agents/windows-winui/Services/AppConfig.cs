using System.Text.Json.Serialization;

namespace LiveDashboardAgent.Services;

public sealed class AppConfig
{
    public string ServerUrl { get; init; } = "";
    public string Token { get; init; } = "";
    public int IntervalSeconds { get; init; } = 5;
    public int HeartbeatSeconds { get; init; } = 60;
    public int IdleThresholdSeconds { get; init; } = 300;
    public bool EnableLog { get; init; } = false;

    public static AppConfig Default { get; } = new();

    public AppConfig Normalize()
    {
        return new AppConfig
        {
            ServerUrl = ServerUrl.Trim(),
            Token = Token.Trim(),
            IntervalSeconds = Clamp(IntervalSeconds, 1, 300, 5),
            HeartbeatSeconds = Clamp(HeartbeatSeconds, 10, 600, 60),
            IdleThresholdSeconds = Clamp(IdleThresholdSeconds, 30, 3600, 300),
            EnableLog = EnableLog,
        };
    }

    public string? Validate()
    {
        var normalized = Normalize();
        if (string.IsNullOrWhiteSpace(normalized.ServerUrl))
        {
            return "服务器地址不能为空";
        }
        if (string.IsNullOrWhiteSpace(normalized.Token) || normalized.Token == "YOUR_TOKEN_HERE")
        {
            return "Token 不能为空";
        }
        if (!Uri.TryCreate(normalized.ServerUrl, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            return "服务器地址必须使用 http:// 或 https://";
        }
        return null;
    }

    private static int Clamp(int value, int min, int max, int fallback)
    {
        return value < min || value > max ? fallback : value;
    }
}

internal sealed class LegacyJsonConfig
{
    [JsonPropertyName("server_url")]
    public string? ServerUrl { get; init; }

    [JsonPropertyName("token")]
    public string? Token { get; init; }

    [JsonPropertyName("interval_seconds")]
    public int? IntervalSeconds { get; init; }

    [JsonPropertyName("heartbeat_seconds")]
    public int? HeartbeatSeconds { get; init; }

    [JsonPropertyName("idle_threshold_seconds")]
    public int? IdleThresholdSeconds { get; init; }

    [JsonPropertyName("enable_log")]
    public bool? EnableLog { get; init; }

    public AppConfig ToAppConfig()
    {
        return new AppConfig
        {
            ServerUrl = ServerUrl ?? "",
            Token = Token ?? "",
            IntervalSeconds = IntervalSeconds ?? AppConfig.Default.IntervalSeconds,
            HeartbeatSeconds = HeartbeatSeconds ?? AppConfig.Default.HeartbeatSeconds,
            IdleThresholdSeconds = IdleThresholdSeconds ?? AppConfig.Default.IdleThresholdSeconds,
            EnableLog = EnableLog ?? AppConfig.Default.EnableLog,
        }.Normalize();
    }
}
