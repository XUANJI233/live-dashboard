using System.Text.Json;

namespace LiveDashboardAgent.Services;

public sealed record DeviceCommandEnvelope(
    string RequestId,
    string CommandId,
    string CreatedBy,
    string IssuedAt,
    string ExpiresAt,
    JsonElement Payload)
{
    public static bool TryFromMessage(DeviceMessage message, out DeviceCommandEnvelope? envelope)
    {
        envelope = null;
        if (message.Payload is not { ValueKind: JsonValueKind.Object } payload ||
            !payload.TryGetProperty("type", out var type) ||
            !string.Equals(type.GetString(), "device_command", StringComparison.Ordinal))
        {
            return false;
        }

        var commandId = Text(payload, "command_id");
        if (commandId.Length == 0)
        {
            return false;
        }

        var body = payload.TryGetProperty("payload", out var payloadBody) &&
            payloadBody.ValueKind == JsonValueKind.Object
                ? payloadBody.Clone()
                : EmptyPayload();

        envelope = new DeviceCommandEnvelope(
            Text(payload, "request_id"),
            commandId,
            Text(payload, "created_by"),
            Text(payload, "issued_at"),
            Text(payload, "expires_at"),
            body);
        return true;
    }

    public bool IsExpired()
    {
        return DateTimeOffset.TryParse(ExpiresAt, out var expiresAt) &&
            expiresAt <= DateTimeOffset.UtcNow;
    }

    public string PayloadText(string propertyName)
    {
        return Payload.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.String
            ? (value.GetString() ?? "").Trim()
            : "";
    }

    public bool PayloadBool(string propertyName)
    {
        return Payload.TryGetProperty(propertyName, out var value) &&
            value.ValueKind == JsonValueKind.True;
    }

    public bool PayloadHasStringItems(string propertyName)
    {
        if (!Payload.TryGetProperty(propertyName, out var value) ||
            value.ValueKind != JsonValueKind.Array)
        {
            return false;
        }
        return value.EnumerateArray().Any(item =>
            item.ValueKind == JsonValueKind.String &&
            !string.IsNullOrWhiteSpace(item.GetString()));
    }

    public string SenderName()
    {
        return CreatedBy switch
        {
            "mcp" => "设备控制",
            "supervision" => "AI 监督",
            "" => "AI 监督",
            _ => CreatedBy,
        };
    }

    private static string Text(JsonElement element, string propertyName)
    {
        return element.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.String
            ? (value.GetString() ?? "").Trim()
            : "";
    }

    private static JsonElement EmptyPayload()
    {
        using var document = JsonDocument.Parse("{}");
        return document.RootElement.Clone();
    }
}
