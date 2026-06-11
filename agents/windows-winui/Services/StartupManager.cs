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
    private readonly InstallScope _scope;

    public StartupManager()
        : this(CurrentExecutablePath(), InstallScope.CurrentUser)
    {
    }

    public StartupManager(string executablePath, InstallScope scope = InstallScope.CurrentUser)
    {
        _executablePath = Path.GetFullPath(executablePath);
        _scope = scope;
    }

    public bool IsEnabled()
    {
        using var key = OpenRunKey(_scope, writable: false);
        var command = key?.GetValue(AppName) as string;
        return IsManagedExecutableCommand(command);
    }

    public StartupChangeResult Toggle()
    {
        return SetEnabled(!IsEnabled());
    }

    public StartupChangeResult SetEnabled(bool enabled)
    {
        if (_scope == InstallScope.AllUsers && !ProcessElevation.IsAdministrator())
        {
            return new StartupChangeResult(
                IsEnabled(),
                false,
                "所有用户自启动需要管理员权限。");
        }

        var cleanupOk = CleanupDuplicateAutostartEntries();
        var registryOk = SetRunValue(enabled);
        var ok = cleanupOk && registryOk;
        var actual = IsEnabled();
        var scope = InstallationMode.LabelFor(_scope);
        var message = enabled
            ? ok
                ? $"{scope}自启动已开启。"
                : $"已尝试开启{scope}自启动，但部分旧启动项未能清理。"
            : ok
                ? $"{scope}自启动已关闭。"
                : $"已尝试关闭{scope}自启动，但部分旧启动项未能清理。";
        return new StartupChangeResult(actual, ok, message);
    }

    public bool CleanupDuplicateAutostartEntries()
    {
        var currentUserOk = CleanupRunKey(Registry.CurrentUser, removeManagedAppName: _scope == InstallScope.AllUsers);
        var machineOk = ProcessElevation.IsAdministrator()
            ? CleanupRunKey(Registry.LocalMachine, removeManagedAppName: _scope == InstallScope.CurrentUser)
            : true;
        var startupFolderOk = CleanupStartupFolder();
        var taskOk = RemoveLegacyScheduledTask();
        return currentUserOk && machineOk && startupFolderOk && taskOk;
    }

    public string CurrentCommandLine()
    {
        return Quote(_executablePath);
    }

    private bool SetRunValue(bool enabled)
    {
        try
        {
            using var key = OpenRunKey(_scope, writable: true);
            if (key is null)
            {
                return false;
            }
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

    private bool CleanupRunKey(RegistryKey root, bool removeManagedAppName)
    {
        try
        {
            using var key = root.CreateSubKey(RunKeyPath, true);
            foreach (var valueName in key.GetValueNames())
            {
                var command = key.GetValue(valueName) as string;
                if (!ShouldRemoveRunValue(valueName, command, removeManagedAppName))
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

    private bool ShouldRemoveRunValue(string valueName, string? command, bool removeManagedAppName)
    {
        if (valueName.Equals(AppName, StringComparison.OrdinalIgnoreCase))
        {
            return removeManagedAppName || !IsManagedExecutableCommand(command);
        }
        if (KnownValueNames.Any(name => valueName.Equals(name, StringComparison.OrdinalIgnoreCase)))
        {
            return true;
        }
        return LooksLikeLiveDashboardCommand(command);
    }

    private static RegistryKey? OpenRunKey(InstallScope scope, bool writable)
    {
        var root = scope == InstallScope.AllUsers ? Registry.LocalMachine : Registry.CurrentUser;
        return writable ? root.CreateSubKey(RunKeyPath, true) : root.OpenSubKey(RunKeyPath, false);
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
