using System.Diagnostics;
using Microsoft.Win32;

namespace LiveDashboardAgent.Services;

public sealed record StartupChangeResult(bool Enabled, bool Ok, string Message);

public sealed class StartupManager
{
    private const string AppName = "LiveDashboardAgent";
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";

    private static readonly string[] KnownValueNames =
    [
        "LiveDashboardAgent",
        "Live Dashboard Agent",
        "live-dashboard-agent",
        "LiveDashboardWindowsAgent",
    ];

    private readonly string _executablePath;

    public StartupManager()
        : this(CurrentExecutablePath())
    {
    }

    public StartupManager(string executablePath)
    {
        _executablePath = Path.GetFullPath(executablePath);
    }

    public bool IsEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath);
        var command = key?.GetValue(AppName) as string;
        return IsManagedExecutableCommand(command);
    }

    public StartupChangeResult Toggle()
    {
        return SetEnabled(!IsEnabled());
    }

    public StartupChangeResult SetEnabled(bool enabled)
    {
        var cleanupOk = CleanupDuplicateAutostartEntries();
        var registryOk = SetRunValue(enabled);
        var ok = cleanupOk && registryOk;
        var actual = IsEnabled();
        var message = enabled
            ? ok
                ? "开机自启动已开启。"
                : "已尝试开启自启动，但部分旧启动项未能清理。"
            : ok
                ? "开机自启动已关闭。"
                : "已尝试关闭自启动，但部分旧启动项未能清理。";
        return new StartupChangeResult(actual, ok, message);
    }

    public bool CleanupDuplicateAutostartEntries()
    {
        var runOk = CleanupRunKey();
        var startupFolderOk = CleanupStartupFolder();
        var taskOk = RemoveLegacyScheduledTask();
        return runOk && startupFolderOk && taskOk;
    }

    public string CurrentCommandLine()
    {
        return Quote(_executablePath);
    }

    private bool SetRunValue(bool enabled)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, true);
            if (enabled)
            {
                key.SetValue(AppName, CurrentCommandLine(), RegistryValueKind.String);
            }
            else
            {
                TryDeleteValue(key, AppName);
            }
            return true;
        }
        catch
        {
            return false;
        }
    }

    private bool CleanupRunKey()
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, true);
            foreach (var valueName in key.GetValueNames())
            {
                var command = key.GetValue(valueName) as string;
                if (!ShouldRemoveRunValue(valueName, command))
                {
                    continue;
                }
                TryDeleteValue(key, valueName);
            }
            return true;
        }
        catch
        {
            return false;
        }
    }

    private bool ShouldRemoveRunValue(string valueName, string? command)
    {
        if (valueName.Equals(AppName, StringComparison.OrdinalIgnoreCase))
        {
            return !IsManagedExecutableCommand(command);
        }
        if (KnownValueNames.Any(name => valueName.Equals(name, StringComparison.OrdinalIgnoreCase)))
        {
            return true;
        }
        return LooksLikeLiveDashboardCommand(command);
    }

    private bool CleanupStartupFolder()
    {
        try
        {
            var startup = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
            if (string.IsNullOrWhiteSpace(startup) || !Directory.Exists(startup))
            {
                return true;
            }
            foreach (var path in Directory.EnumerateFiles(startup, "*.lnk"))
            {
                var name = Path.GetFileNameWithoutExtension(path);
                if (name.Contains("LiveDashboard", StringComparison.OrdinalIgnoreCase) ||
                    name.Contains("Live Dashboard", StringComparison.OrdinalIgnoreCase))
                {
                    File.Delete(path);
                }
            }
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool RemoveLegacyScheduledTask()
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = "schtasks.exe",
                ArgumentList = { "/delete", "/tn", AppName, "/f" },
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
            });
            if (process is null)
            {
                return false;
            }
            process.WaitForExit(10_000);
            return process.ExitCode == 0 || process.ExitCode == 1;
        }
        catch
        {
            return false;
        }
    }

    private bool IsManagedExecutableCommand(string? command)
    {
        var path = ExtractExecutablePath(command);
        if (string.IsNullOrWhiteSpace(path))
        {
            return false;
        }
        return string.Equals(
            Path.GetFullPath(path),
            _executablePath,
            StringComparison.OrdinalIgnoreCase);
    }

    private static bool LooksLikeLiveDashboardCommand(string? command)
    {
        if (string.IsNullOrWhiteSpace(command))
        {
            return false;
        }
        return command.Contains("LiveDashboardAgent", StringComparison.OrdinalIgnoreCase) ||
            command.Contains("live-dashboard-agent", StringComparison.OrdinalIgnoreCase);
    }

    private static string CurrentExecutablePath()
    {
        return Environment.ProcessPath ??
            Process.GetCurrentProcess().MainModule?.FileName ??
            AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    }

    private static string? ExtractExecutablePath(string? command)
    {
        if (string.IsNullOrWhiteSpace(command))
        {
            return null;
        }
        var trimmed = command.Trim();
        if (trimmed.StartsWith('"'))
        {
            var end = trimmed.IndexOf('"', 1);
            return end > 1 ? trimmed[1..end] : null;
        }
        var firstSpace = trimmed.IndexOf(' ');
        return firstSpace > 0 ? trimmed[..firstSpace] : trimmed;
    }

    private static string Quote(string value)
    {
        return $"\"{value}\"";
    }

    private static void TryDeleteValue(RegistryKey key, string name)
    {
        try
        {
            key.DeleteValue(name, false);
        }
        catch
        {
            // Best-effort duplicate cleanup; the UI reports aggregate failure.
        }
    }
}
