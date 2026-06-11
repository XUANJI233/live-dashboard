using System.Text.Json;
using Microsoft.Win32;

namespace LiveDashboardAgent.Services;

public sealed class RegistryConfigStore
{
    public const string RegistryPath = @"Software\LiveDashboardAgent";
    private const string SchemaVersion = "1";

    public AppConfig Load()
    {
        TryMigrateLegacyJson();
        using var key = Registry.CurrentUser.OpenSubKey(RegistryPath);
        if (key is null)
        {
            return AppConfig.Default;
        }

        return new AppConfig
        {
            ServerUrl = ReadString(key, "ServerUrl", AppConfig.Default.ServerUrl),
            Token = ReadString(key, "Token", AppConfig.Default.Token),
            IntervalSeconds = ReadInt(key, "IntervalSeconds", AppConfig.Default.IntervalSeconds),
            HeartbeatSeconds = ReadInt(key, "HeartbeatSeconds", AppConfig.Default.HeartbeatSeconds),
            IdleThresholdSeconds = ReadInt(key, "IdleThresholdSeconds", AppConfig.Default.IdleThresholdSeconds),
            EnableLog = ReadBool(key, "EnableLog", AppConfig.Default.EnableLog),
        }.Normalize();
    }

    public void Save(AppConfig config)
    {
        var normalized = config.Normalize();
        using var key = Registry.CurrentUser.CreateSubKey(RegistryPath, true);
        key.SetValue("SchemaVersion", SchemaVersion, RegistryValueKind.String);
        key.SetValue("ServerUrl", normalized.ServerUrl, RegistryValueKind.String);
        key.SetValue("Token", normalized.Token, RegistryValueKind.String);
        key.SetValue("IntervalSeconds", normalized.IntervalSeconds, RegistryValueKind.DWord);
        key.SetValue("HeartbeatSeconds", normalized.HeartbeatSeconds, RegistryValueKind.DWord);
        key.SetValue("IdleThresholdSeconds", normalized.IdleThresholdSeconds, RegistryValueKind.DWord);
        key.SetValue("EnableLog", normalized.EnableLog ? "true" : "false", RegistryValueKind.String);
    }

    public bool TryMigrateLegacyJson()
    {
        using var existing = Registry.CurrentUser.OpenSubKey(RegistryPath);
        if (!string.IsNullOrWhiteSpace(existing?.GetValue("ServerUrl") as string) ||
            !string.IsNullOrWhiteSpace(existing?.GetValue("Token") as string))
        {
            return false;
        }

        foreach (var path in LegacyConfigPaths())
        {
            var migrated = TryReadLegacyJson(path);
            if (migrated is null)
            {
                continue;
            }
            Save(migrated);
            using var key = Registry.CurrentUser.CreateSubKey(RegistryPath, true);
            key.SetValue("MigratedFrom", path, RegistryValueKind.String);
            return true;
        }
        return false;
    }

    private static IEnumerable<string> LegacyConfigPaths()
    {
        yield return Path.Combine(AppContext.BaseDirectory, "config.json");

        var sourceTreePath = FindSourceTreeConfig();
        if (!string.IsNullOrWhiteSpace(sourceTreePath))
        {
            yield return sourceTreePath;
        }
    }

    private static string? FindSourceTreeConfig()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null)
        {
            var candidate = Path.Combine(current.FullName, "agents", "windows", "config.json");
            if (File.Exists(candidate))
            {
                return candidate;
            }
            current = current.Parent;
        }
        return null;
    }

    private static AppConfig? TryReadLegacyJson(string path)
    {
        try
        {
            if (!File.Exists(path))
            {
                return null;
            }
            var json = File.ReadAllText(path);
            var legacy = JsonSerializer.Deserialize<LegacyJsonConfig>(json);
            return legacy?.ToAppConfig();
        }
        catch
        {
            return null;
        }
    }

    private static string ReadString(RegistryKey key, string name, string fallback)
    {
        return key.GetValue(name) is string value ? value.Trim() : fallback;
    }

    private static int ReadInt(RegistryKey key, string name, int fallback)
    {
        return key.GetValue(name) switch
        {
            int value => value,
            string value when int.TryParse(value, out var parsed) => parsed,
            _ => fallback,
        };
    }

    private static bool ReadBool(RegistryKey key, string name, bool fallback)
    {
        return key.GetValue(name) switch
        {
            string value when bool.TryParse(value, out var parsed) => parsed,
            bool value => value,
            _ => fallback,
        };
    }
}
