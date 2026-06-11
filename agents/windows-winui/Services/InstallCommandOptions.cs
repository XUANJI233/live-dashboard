namespace LiveDashboardAgent.Services;

using System.Text;

public sealed record InstallCommandOptions(
    InstallAction Action,
    InstallScope Scope,
    string InstallDirectory,
    string? ResultPath = null,
    int? ParentProcessId = null,
    bool RemoveLogs = false,
    bool CreateDesktopShortcut = false)
{
    private const string ActionFlag = "--install-action";
    private const string ScopeFlag = "--install-scope";
    private const string DirectoryFlag = "--install-dir";
    private const string EncodedDirectoryFlag = "--install-dir-b64";
    private const string ResultFlag = "--install-result";
    private const string ParentPidFlag = "--parent-pid";
    private const string RemoveLogsFlag = "--remove-logs";
    private const string DesktopShortcutFlag = "--desktop-shortcut";

    public static bool TryParse(string[] args, out InstallCommandOptions? command)
    {
        command = null;
        var values = ReadFlags(args);
        if (!values.TryGetValue(ActionFlag, out var actionValue) ||
            !values.TryGetValue(ScopeFlag, out var scopeValue))
        {
            return false;
        }

        if (!TryParseAction(actionValue, out var action) ||
            !TryParseScope(scopeValue, out var scope) ||
            !TryReadDirectory(values, out var directoryValue))
        {
            return false;
        }

        values.TryGetValue(ResultFlag, out var resultPath);
        var parentProcessId = values.TryGetValue(ParentPidFlag, out var parentValue) &&
            int.TryParse(parentValue, out var parsedParent)
                ? parsedParent
                : (int?)null;
        var removeLogs = values.TryGetValue(RemoveLogsFlag, out var removeLogsValue) &&
            bool.TryParse(removeLogsValue, out var parsedRemoveLogs) &&
            parsedRemoveLogs;
        var createDesktopShortcut = values.TryGetValue(DesktopShortcutFlag, out var desktopShortcutValue) &&
            bool.TryParse(desktopShortcutValue, out var parsedDesktopShortcut) &&
            parsedDesktopShortcut;

        command = new InstallCommandOptions(
            action,
            scope,
            directoryValue,
            resultPath,
            parentProcessId,
            removeLogs,
            createDesktopShortcut);
        return true;
    }

    public IReadOnlyList<string> ToArguments()
    {
        var args = new List<string>
        {
            ActionFlag,
            FormatAction(Action),
            ScopeFlag,
            FormatScope(Scope),
            EncodedDirectoryFlag,
            EncodeDirectory(InstallDirectory),
        };
        if (!string.IsNullOrWhiteSpace(ResultPath))
        {
            args.Add(ResultFlag);
            args.Add(ResultPath);
        }
        if (ParentProcessId is > 0)
        {
            args.Add(ParentPidFlag);
            args.Add(ParentProcessId.Value.ToString());
        }
        args.Add(RemoveLogsFlag);
        args.Add(RemoveLogs ? "true" : "false");
        args.Add(DesktopShortcutFlag);
        args.Add(CreateDesktopShortcut ? "true" : "false");
        return args;
    }

    private static bool TryReadDirectory(
        IReadOnlyDictionary<string, string> values,
        out string directory)
    {
        if (values.TryGetValue(EncodedDirectoryFlag, out var encodedDirectory))
        {
            try
            {
                directory = Encoding.UTF8.GetString(Convert.FromBase64String(encodedDirectory));
                return true;
            }
            catch
            {
                directory = "";
                return false;
            }
        }
        return values.TryGetValue(DirectoryFlag, out directory!);
    }

    private static string EncodeDirectory(string directory)
    {
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(directory));
    }

    private static Dictionary<string, string> ReadFlags(string[] args)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < args.Length - 1; index++)
        {
            var flag = args[index];
            if (!flag.StartsWith("--", StringComparison.Ordinal))
            {
                continue;
            }
            values[flag] = args[index + 1];
            index++;
        }
        return values;
    }

    private static bool TryParseAction(string value, out InstallAction action)
    {
        switch (value)
        {
            case "install":
                action = InstallAction.Install;
                return true;
            case "uninstall":
                action = InstallAction.Uninstall;
                return true;
            default:
                action = InstallAction.Install;
                return false;
        }
    }

    private static bool TryParseScope(string value, out InstallScope scope)
    {
        switch (value)
        {
            case "current-user":
                scope = InstallScope.CurrentUser;
                return true;
            case "all-users":
                scope = InstallScope.AllUsers;
                return true;
            default:
                scope = InstallScope.CurrentUser;
                return false;
        }
    }

    private static string FormatAction(InstallAction action)
    {
        return action switch
        {
            InstallAction.Install => "install",
            InstallAction.Uninstall => "uninstall",
            _ => throw new InvalidOperationException($"Unknown install action: {action}"),
        };
    }

    private static string FormatScope(InstallScope scope)
    {
        return scope == InstallScope.AllUsers ? "all-users" : "current-user";
    }
}
