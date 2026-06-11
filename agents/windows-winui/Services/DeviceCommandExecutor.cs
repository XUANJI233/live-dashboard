namespace LiveDashboardAgent.Services;

public static class DeviceCommandExecutor
{
    public static Dictionary<string, object?> ReceiptFrame(DeviceCommandEnvelope envelope)
    {
        return new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["type"] = "device_command_receipt",
            ["request_id"] = envelope.RequestId,
            ["command_id"] = envelope.CommandId,
            ["status"] = "received",
            ["received_at"] = NowIso(),
        };
    }

    public static DeviceCommandExecution Execute(DeviceCommandEnvelope envelope)
    {
        var kind = envelope.PayloadText("kind");
        var say = Trim(envelope.PayloadText("say"), 500);
        var actions = new List<Dictionary<string, object?>>();
        var unsupported = new List<string>();
        string status;
        string reason;

        if (envelope.IsExpired())
        {
            status = "expired";
            reason = "command_expired";
        }
        else if (kind == "supervision_policy")
        {
            status = "unsupported";
            reason = "policy_requires_android_lsp";
        }
        else if (kind != "supervision")
        {
            status = "unsupported";
            reason = "unsupported_command_kind:" + (string.IsNullOrWhiteSpace(kind) ? "missing" : kind);
        }
        else
        {
            if (!string.IsNullOrWhiteSpace(say))
            {
                actions.Add(new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["action"] = "say",
                    ["status"] = "applied",
                });
            }
            if (envelope.PayloadHasStringItems("freeze_commands"))
            {
                unsupported.Add("freeze");
            }
            if (envelope.PayloadHasStringItems("unfreeze_commands"))
            {
                unsupported.Add("unfreeze");
            }
            if (envelope.PayloadBool("vibrate"))
            {
                unsupported.Add("vibrate");
            }
            if (envelope.PayloadBool("screen_off"))
            {
                unsupported.Add("screen_off");
            }

            if (!string.IsNullOrWhiteSpace(say) && unsupported.Count > 0)
            {
                status = "partial";
                reason = "unsupported_actions:" + string.Join(",", unsupported);
            }
            else if (!string.IsNullOrWhiteSpace(say))
            {
                status = "applied";
                reason = "";
            }
            else if (unsupported.Count > 0)
            {
                status = "unsupported";
                reason = "unsupported_actions:" + string.Join(",", unsupported);
            }
            else
            {
                status = "ignored";
                reason = "empty_desktop_command";
            }
        }

        var appliedSay = actions.Any(action =>
            string.Equals(action.GetValueOrDefault("action") as string, "say", StringComparison.Ordinal) &&
            string.Equals(action.GetValueOrDefault("status") as string, "applied", StringComparison.Ordinal));
        var result = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["type"] = "device_command_result",
            ["request_id"] = envelope.RequestId,
            ["command_id"] = envelope.CommandId,
            ["result_id"] = string.IsNullOrWhiteSpace(envelope.CommandId) ? "" : "res_" + envelope.CommandId,
            ["status"] = status,
            ["executed_at"] = NowIso(),
            ["actions"] = actions,
            ["state_after"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["desktop_message_visible"] = appliedSay,
            },
            ["reason"] = reason,
        };

        var displayMessage = appliedSay
            ? new DeviceMessage(
                envelope.CommandId,
                "__mcp__",
                envelope.SenderName(),
                "",
                "device_command",
                "viewer",
                say,
                string.IsNullOrWhiteSpace(envelope.IssuedAt) ? NowIso() : envelope.IssuedAt,
                false,
                null)
            : null;

        return new DeviceCommandExecution(result, displayMessage);
    }

    private static string NowIso()
    {
        return DateTimeOffset.UtcNow.ToString("O");
    }

    private static string Trim(string value, int maxLength)
    {
        return value.Length <= maxLength ? value : value[..maxLength];
    }
}

public sealed record DeviceCommandExecution(
    Dictionary<string, object?> ResultFrame,
    DeviceMessage? DisplayMessage);
