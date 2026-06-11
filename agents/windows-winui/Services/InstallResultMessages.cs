namespace LiveDashboardAgent.Services;

internal static class InstallResultMessages
{
    public static string BuildUninstallMessage(
        ManifestRemovalResult removal,
        RuntimeArtifactCleanupResult logs,
        DesktopShortcutResult shortcut,
        bool removeLogs,
        string startupMessage)
    {
        if (!removal.Ok)
        {
            return removal.Error ?? startupMessage;
        }
        if (removeLogs && logs.SkippedLogs > 0)
        {
            return "已卸载程序文件，但部分日志文件正在使用或无法删除。";
        }
        if (removeLogs && logs.DeletedLogs > 0)
        {
            return shortcut.Ok ? "已卸载程序文件、桌面快捷方式并清理日志。" : shortcut.Message;
        }
        return shortcut.Ok ? "已卸载程序文件和桌面快捷方式。" : shortcut.Message;
    }

    public static string BuildInstallMessage(
        string scope,
        StartupChangeResult startup,
        DesktopShortcutResult shortcut,
        bool shortcutRequested)
    {
        if (!startup.Ok)
        {
            return shortcutRequested && shortcut.Ok
                ? $"{startup.Message} 桌面快捷方式已创建。"
                : startup.Message;
        }

        if (shortcutRequested && !shortcut.Ok)
        {
            return $"已安装到{scope}路径并开启自启动，但{shortcut.Message}";
        }

        return shortcutRequested
            ? $"已安装到{scope}路径，已创建桌面快捷方式并开启自启动。"
            : $"已安装到{scope}路径，并已开启自启动。";
    }

    public static string BuildMissingDirectoryUninstallMessage(DesktopShortcutResult shortcut)
    {
        return shortcut.Ok
            ? "自启动和桌面快捷方式已移除，安装目录不存在。"
            : $"自启动已移除，但{shortcut.Message}";
    }

    public static string BuildPendingUninstallMessage(DesktopShortcutResult shortcut)
    {
        return shortcut.Ok
            ? "自启动和桌面快捷方式已移除，应用关闭后会删除安装目录。"
            : $"自启动已移除，应用关闭后会删除安装目录，但{shortcut.Message}";
    }
}
