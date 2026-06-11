using Microsoft.Win32;

namespace LiveDashboardAgent.Services;

internal sealed record InstallRegistryRecord(
    string Scope,
    string InstallDirectory,
    string ManifestSha256,
    int FileCount,
    string InstalledAt);

internal static class InstallRegistryStore
{
    private const string RegistryPath = @"Software\LiveDashboardAgent\Install";

    public static void Save(InstallScope scope, InstallManifestSummary summary)
    {
        using var key = CreateScopeKey(scope);
        key.SetValue("Scope", scope.ToString(), RegistryValueKind.String);
        key.SetValue("InstallDirectory", summary.InstallDirectory, RegistryValueKind.String);
        key.SetValue("ManifestSha256", summary.ManifestSha256, RegistryValueKind.String);
        key.SetValue("FileCount", summary.FileCount, RegistryValueKind.DWord);
        key.SetValue("InstalledAt", DateTimeOffset.UtcNow.ToString("O"), RegistryValueKind.String);
    }

    public static InstallRegistryRecord? Load(InstallScope scope)
    {
        try
        {
            using var key = OpenScopeKey(scope, writable: false);
            if (key is null)
            {
                return null;
            }

            return new InstallRegistryRecord(
                ReadString(key, "Scope"),
                ReadString(key, "InstallDirectory"),
                ReadString(key, "ManifestSha256"),
                ReadInt(key, "FileCount"),
                ReadString(key, "InstalledAt"));
        }
        catch
        {
            return null;
        }
    }

    public static void Clear(InstallScope scope)
    {
        try
        {
            var root = scope == InstallScope.AllUsers ? Registry.LocalMachine : Registry.CurrentUser;
            using var parent = root.OpenSubKey(RegistryPath, writable: true);
            parent?.DeleteSubKeyTree(ScopeKeyName(scope), throwOnMissingSubKey: false);
        }
        catch
        {
            // A stale install record is safer than deleting the wrong directory.
        }
    }

    private static RegistryKey CreateScopeKey(InstallScope scope)
    {
        var root = scope == InstallScope.AllUsers ? Registry.LocalMachine : Registry.CurrentUser;
        return root.CreateSubKey($@"{RegistryPath}\{ScopeKeyName(scope)}", writable: true)!;
    }

    private static RegistryKey? OpenScopeKey(InstallScope scope, bool writable)
    {
        var root = scope == InstallScope.AllUsers ? Registry.LocalMachine : Registry.CurrentUser;
        return root.OpenSubKey($@"{RegistryPath}\{ScopeKeyName(scope)}", writable);
    }

    private static string ScopeKeyName(InstallScope scope)
    {
        return scope == InstallScope.AllUsers ? "AllUsers" : "CurrentUser";
    }

    private static string ReadString(RegistryKey key, string name)
    {
        return key.GetValue(name) as string ?? "";
    }

    private static int ReadInt(RegistryKey key, string name)
    {
        return key.GetValue(name) is int value ? value : 0;
    }
}
