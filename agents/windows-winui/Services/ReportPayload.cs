using System.Text.Json.Serialization;

namespace LiveDashboardAgent.Services;

public sealed record ReportPayload(
    [property: JsonPropertyName("app_id")] string AppId,
    [property: JsonPropertyName("window_title")] string WindowTitle,
    [property: JsonPropertyName("timestamp")] string Timestamp,
    [property: JsonPropertyName("extra")] Dictionary<string, object> Extra);
