using LiveDashboardAgent.Services;

namespace LiveDashboardAgent.ViewModels;

public sealed class MessageDisplayItem
{
    private MessageDisplayItem(DeviceMessage message)
    {
        Id = message.MessageId;
        Sender = FormatSender(message);
        Preview = PreviewText(message.Text);
        CreatedAtShort = FormatTime(message.CreatedAt, "MM-dd HH:mm");
        CreatedAtLong = FormatTime(message.CreatedAt, "yyyy-MM-dd HH:mm:ss");
        Direction = FormatDirection(message.Direction);
        Kind = FormatKind(message.Kind);
        Body = string.IsNullOrWhiteSpace(message.Text) ? "无内容" : message.Text.Trim();
        DetailMeta = $"{CreatedAtLong} · {Kind} · {Direction}";
    }

    public string Id { get; }
    public string Sender { get; }
    public string Preview { get; }
    public string CreatedAtShort { get; }
    public string CreatedAtLong { get; }
    public string Direction { get; }
    public string Kind { get; }
    public string Body { get; }
    public string DetailMeta { get; }

    public static MessageDisplayItem From(DeviceMessage message)
    {
        return new MessageDisplayItem(message);
    }

    private static string FormatSender(DeviceMessage message)
    {
        if (string.Equals(message.Direction, "device", StringComparison.OrdinalIgnoreCase))
        {
            return "设备回复";
        }
        if (!string.IsNullOrWhiteSpace(message.ViewerRemark))
        {
            return message.ViewerRemark.Trim();
        }
        if (!string.IsNullOrWhiteSpace(message.ViewerName))
        {
            return message.ViewerName.Trim();
        }
        return string.IsNullOrWhiteSpace(message.ViewerId) ? "未知访客" : message.ViewerId.Trim();
    }

    private static string PreviewText(string value)
    {
        var text = value.Replace("\r", " ").Replace("\n", " ").Trim();
        if (text.Length == 0)
        {
            return "无内容";
        }
        return text.Length > 64 ? text[..64].TrimEnd() + "..." : text;
    }

    private static string FormatTime(string value, string format)
    {
        if (!DateTimeOffset.TryParse(value, out var parsed))
        {
            return string.IsNullOrWhiteSpace(value) ? "未知时间" : value.Trim();
        }
        return parsed.ToLocalTime().ToString(format);
    }

    private static string FormatDirection(string value)
    {
        return string.Equals(value, "device", StringComparison.OrdinalIgnoreCase) ? "已回复" : "访客";
    }

    private static string FormatKind(string value)
    {
        return value switch
        {
            "reply" => "回复",
            "private" => "私聊",
            "public" => "公开",
            "public_reply" => "公开回复",
            _ => string.IsNullOrWhiteSpace(value) ? "消息" : value,
        };
    }
}
