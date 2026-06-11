using System.Text.Json;

namespace LiveDashboardAgent.Services;

public sealed record DeviceMessage(
    string MessageId,
    string ViewerId,
    string ViewerName,
    string ViewerRemark,
    string Kind,
    string Direction,
    string Text,
    string CreatedAt,
    bool Queued,
    JsonElement? Payload)
{
    public bool IsDeviceCommand =>
        Payload is { ValueKind: JsonValueKind.Object } payload &&
        payload.TryGetProperty("type", out var type) &&
        string.Equals(type.GetString(), "device_command", StringComparison.Ordinal);
}
