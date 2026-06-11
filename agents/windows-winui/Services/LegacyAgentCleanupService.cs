using System.Diagnostics;
using Microsoft.Win32;

namespace LiveDashboardAgent.Services;

public sealed class LegacyAgentCleanupService
{
    private static readonly string[] LegacyExecutableNames =
    [
        "live-dashboard-agent.exe",
    ];

    public LegacyCleanupResult Run()
    {
        CleanupLegacyRunValues();
        return StopLegacyProcesses();
    }

    private static void CleanupLegacyRunValues()
    {
        CleanupLegacyRunValues(Registry.CurrentUser);
        if (ProcessElevation.IsAdministrator())
        {
            CleanupLegacyRunValues(Registry.LocalMachine);
        }
    }

    private static void CleanupLegacyRunValues(RegistryKey root)
    {
        try
        {
            using var key = root.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Run",
                writable: true);
            if (key is null)
            {
                return;
            }

            foreach (var valueName in key.GetValueNames())
            {
                var command = key.GetValue(valueName) as string;
                if (LooksLikeLegacyAutostartCommand(command))
                {
                    key.DeleteValue(valueName, false);
                }
            }
        }
        catch
        {
            // Launch-time migration should never prevent the agent UI from opening.
        }
    }

    private static LegacyCleanupResult StopLegacyProcesses()
    {
        var stopped = 0;
        var failed = 0;
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                if (!LooksLikeLegacyAgent(process))
                {
                    continue;
                }

                if (TryStop(process))
                {
                    stopped++;
                }
                else
                {
                    failed++;
                }
            }
        }

        return new LegacyCleanupResult(stopped, failed);
    }

    private static bool LooksLikeLegacyAgent(Process process)
    {
        try
        {
            if (process.Id == Environment.ProcessId)
            {
                return false;
            }

            var processName = SafeProcessName(process);
            if (!LegacyExecutableNames.Contains(processName, StringComparer.OrdinalIgnoreCase))
            {
                return false;
            }

            var executablePath = SafeMainModulePath(process);
            if (IsCurrentWinUiExecutable(executablePath))
            {
                return false;
            }

            return IsLegacyPackagedExecutable(processName, executablePath);
        }
        catch
        {
            return false;
        }
    }

    private static bool IsLegacyPackagedExecutable(
        string processName,
        string? executablePath)
    {
        if (!processName.Equals("live-dashboard-agent.exe", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return ContainsLiveDashboardHint(executablePath);
    }

    private static bool TryStop(Process process)
    {
        try
        {
            if (process.CloseMainWindow() && process.WaitForExit(3_000))
            {
                return true;
            }

            if (process.HasExited)
            {
                return true;
            }

            process.Kill(entireProcessTree: true);
            return process.WaitForExit(5_000);
        }
        catch
        {
            return false;
        }
    }

    private static string SafeProcessName(Process process)
    {
        try
        {
            var path = SafeMainModulePath(process);
            if (!string.IsNullOrWhiteSpace(path))
            {
                return Path.GetFileName(path);
            }
        }
        catch
        {
            // Fall back to ProcessName below.
        }

        return process.ProcessName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
            ? process.ProcessName
            : process.ProcessName + ".exe";
    }

    private static string? SafeMainModulePath(Process process)
    {
        try
        {
            return process.MainModule?.FileName;
        }
        catch
        {
            return null;
        }
    }

    private static bool IsCurrentWinUiExecutable(string? executablePath)
    {
        if (string.IsNullOrWhiteSpace(executablePath))
        {
            return false;
        }

        var current = InstallExecutableResolver.CurrentExecutablePath();
        return string.Equals(
            Path.GetFullPath(executablePath),
            Path.GetFullPath(current),
            StringComparison.OrdinalIgnoreCase);
    }

    private static bool ContainsLiveDashboardHint(string? value)
    {
        return value?.Contains("live-dashboard-agent", StringComparison.OrdinalIgnoreCase) == true ||
            value?.Contains("LiveDashboardAgent", StringComparison.OrdinalIgnoreCase) == true;
    }

    private static bool LooksLikeLegacyAutostartCommand(string? command)
    {
        if (string.IsNullOrWhiteSpace(command))
        {
            return false;
        }

        return command.Contains("live-dashboard-agent", StringComparison.OrdinalIgnoreCase) ||
            command.Contains(@"agents\windows\agent.py", StringComparison.OrdinalIgnoreCase) ||
            command.Contains(@"/agents/windows/agent.py", StringComparison.OrdinalIgnoreCase);
    }
}

public sealed record LegacyCleanupResult(int StoppedProcesses, int FailedProcesses);
