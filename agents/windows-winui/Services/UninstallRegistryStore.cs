using System.Reflection;
using Microsoft.Win32;

namespace LiveDashboardAgent.Services;

internal static class UninstallRegistryStore
{
    private const string AppId = "LiveDashboardAgent";
    private const string DisplayName = "Live Dashboard Agent";
    private const string Publisher = "Live Dashboard";
    private const string UninstallRegistryPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall";

    public static void Save(InstallScope scope, string executablePath, string installDirectory)
    {
        using var key = CreateAppKey(scope);
        var executable = Path.GetFullPath(executablePath);
        var directory = InstallDirectorySafety.NormalizeDirectory(installDirectory);
        var uninstallCommand = BuildCommand(
            executable,
            new InstallCommandOptions(
                InstallAction.Uninstall,
                scope,
                directory,
                RemoveLogs: false));

        key.SetValue("DisplayName", DisplayName, RegistryValueKind.String);
        key.SetValue("DisplayVersion", VersionText(), RegistryValueKind.String);
        key.SetValue("Publisher", Publisher, RegistryValueKind.String);
        key.SetValue("InstallLocation", directory, RegistryValueKind.String);
        key.SetValue("DisplayIcon", $"{executable},0", RegistryValueKind.String);
        key.SetValue("UninstallString", uninstallCommand, RegistryValueKind.String);
        key.SetValue("QuietUninstallString", uninstallCommand, RegistryValueKind.String);
        key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"), RegistryValueKind.String);
        key.SetValue("EstimatedSize", EstimateSizeKb(directory), RegistryValueKind.DWord);
        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
    }

    public static void Clear(InstallScope scope)
    {
        try
        {
            var root = Root(scope);
            using var parent = root.OpenSubKey(UninstallRegistryPath, writable: true);
            parent?.DeleteSubKeyTree(AppId, throwOnMissingSubKey: false);
        }
        catch
        {
            // A stale Windows uninstall entry is safer than deleting an unknown key.
        }
    }

    public static string RegistryPathForPowerShell(InstallScope scope)
    {
        return scope == InstallScope.AllUsers
            ? $@"HKLM:\{UninstallRegistryPath}\{AppId}"
            : $@"HKCU:\{UninstallRegistryPath}\{AppId}";
    }

    private static RegistryKey CreateAppKey(InstallScope scope)
    {
        return Root(scope).CreateSubKey($@"{UninstallRegistryPath}\{AppId}", writable: true)!;
    }

    private static RegistryKey Root(InstallScope scope)
    {
        return scope == InstallScope.AllUsers ? Registry.LocalMachine : Registry.CurrentUser;
    }

    private static string VersionText()
    {
        return Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "1.0.0.0";
    }

    private static int EstimateSizeKb(string installDirectory)
    {
        try
        {
            var bytes = Directory
                .EnumerateFiles(installDirectory, "*", SearchOption.AllDirectories)
                .Sum(file => new FileInfo(file).Length);
            return Math.Max(1, (int)Math.Min(int.MaxValue, bytes / 1024));
        }
        catch
        {
            return 1;
        }
    }

    private static string BuildCommand(string executablePath, InstallCommandOptions options)
    {
        return string.Join(
            " ",
            new[] { Quote(executablePath) }.Concat(options.ToArguments().Select(Quote)));
    }

    private static string Quote(string value)
    {
        return value.Any(char.IsWhiteSpace) || value.Contains('"')
            ? $"\"{value.Replace("\"", "\\\"")}\""
            : value;
    }
}
