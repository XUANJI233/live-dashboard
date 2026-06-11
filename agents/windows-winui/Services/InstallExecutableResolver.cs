using System.Diagnostics;

namespace LiveDashboardAgent.Services;

internal static class InstallExecutableResolver
{
    public const string InstalledExecutableName = "LiveDashboardAgent.exe";

    public static bool IsRunningFromDirectory(string installDirectory)
    {
        if (!InstallDirectorySafety.TryNormalizeDirectory(installDirectory, out var install, out _))
        {
            return false;
        }
        var current = InstallDirectorySafety.NormalizeDirectory(AppContext.BaseDirectory);
        return string.Equals(current, install, StringComparison.OrdinalIgnoreCase);
    }

    public static string ResolveStartupExecutable(string installDirectory)
    {
        var normalizedDirectory = InstallDirectorySafety.NormalizeDirectory(installDirectory);
        var installedExecutable = Path.Combine(normalizedDirectory, InstalledExecutableName);
        return File.Exists(installedExecutable) ? installedExecutable : CurrentExecutablePath();
    }

    public static string CurrentExecutablePath()
    {
        return Environment.ProcessPath ??
            Process.GetCurrentProcess().MainModule?.FileName ??
            Path.Combine(AppContext.BaseDirectory, InstalledExecutableName);
    }
}
