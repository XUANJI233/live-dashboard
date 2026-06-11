using System.Text.Json;
using System.Text.Json.Serialization;

namespace LiveDashboardAgent.Services;

public static class DeviceMessageResponseParser
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    public static IReadOnlyList<DeviceMessage> Parse(string json)
    {
        var response = JsonSerializer.Deserialize<DeviceMessagesResponse>(json, JsonOptions);
        if (response?.Messages is null)
        {
            return [];
        }

        var messages = new List<DeviceMessage>();
        foreach (var row in response.Messages)
        {
            var message = Normalize(row);
            if (message is not null)
            {
                messages.Add(message);
            }
        }
        return messages;
    }

    private static DeviceMessage? Normalize(DeviceMessageRow row)
    {
        var messageId = Text(row.MessageId) is { Length: > 0 } explicitId
            ? explicitId
            : Text(row.Id);
        if (messageId.Length == 0)
        {
            return null;
        }

        return new DeviceMessage(
            messageId,
            Text(row.ViewerId),
            Text(row.ViewerName),
            Text(row.ViewerRemark),
            Text(row.Kind, "text"),
            Text(row.Direction),
            Text(row.Text),
            Text(row.CreatedAt),
            row.Queued is true,
            row.Payload.HasValue ? row.Payload.Value.Clone() : null);
    }

    private static string Text(string? value, string fallback = "")
    {
        return string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
    }
}

internal sealed class DeviceMessagesResponse
{
    [JsonPropertyName("messages")]
    public List<DeviceMessageRow>? Messages { get; init; }
}

internal sealed class DeviceMessageRow
{
    [JsonPropertyName("id")]
    public string? Id { get; init; }

    [JsonPropertyName("message_id")]
    public string? MessageId { get; init; }

    [JsonPropertyName("viewer_id")]
    public string? ViewerId { get; init; }

    [JsonPropertyName("viewer_name")]
    public string? ViewerName { get; init; }

    [JsonPropertyName("viewer_remark")]
    public string? ViewerRemark { get; init; }

    [JsonPropertyName("kind")]
    public string? Kind { get; init; }

    [JsonPropertyName("direction")]
    public string? Direction { get; init; }

    [JsonPropertyName("text")]
    public string? Text { get; init; }

    [JsonPropertyName("created_at")]
    public string? CreatedAt { get; init; }

    [JsonPropertyName("queued")]
    public bool? Queued { get; init; }

    [JsonPropertyName("payload")]
    public JsonElement? Payload { get; init; }
}
