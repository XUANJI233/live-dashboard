using System.Security.Cryptography;
using System.Text.Json;

namespace LiveDashboardAgent.Services;

internal sealed record InstallManifestDocument(
    string App,
    string Scope,
    string InstallDirectory,
    DateTimeOffset InstalledAt,
    IReadOnlyList<InstallManifestEntry> Files);

internal sealed record InstallManifestEntry(
    string RelativePath,
    long Length,
    string Sha256);

internal sealed record ManifestRemovalResult(
    bool Ok,
    bool Changed,
    int DeletedFiles,
    int SkippedFiles,
    string? Error);

internal sealed record InstallManifestSummary(
    string InstallDirectory,
    string Scope,
    int FileCount,
    string ManifestSha256);

internal static class InstallManifestStore
{
    public const string ManifestFileName = ".live-dashboard-agent-manifest.json";
    private const string AppName = "LiveDashboardAgent";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
    };

    public static void Write(
        string installDirectory,
        InstallScope scope,
        IEnumerable<string> installedRelativePaths)
    {
        var target = InstallDirectorySafety.NormalizeDirectory(installDirectory);
        var files = installedRelativePaths
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Select(relativePath => ResolveManifestPath(target, relativePath))
            .Where(file => file is not null && File.Exists(file))
            .Select(file => CreateEntry(target, file!))
            .OrderBy(entry => entry.RelativePath, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var manifest = new InstallManifestDocument(
            AppName,
            scope.ToString(),
            target,
            DateTimeOffset.UtcNow,
            files);
        File.WriteAllText(ManifestPath(target), JsonSerializer.Serialize(manifest, JsonOptions));
    }

    public static InstallManifestSummary? ReadSummary(string installDirectory)
    {
        var target = InstallDirectorySafety.NormalizeDirectory(installDirectory);
        var manifest = Read(target);
        if (manifest is null)
        {
            return null;
        }
        return new InstallManifestSummary(
            target,
            manifest.Scope,
            manifest.Files.Count,
            ComputeSha256(ManifestPath(target)));
    }

    public static string? ValidateForRemoval(InstallScope scope, string installDirectory)
    {
        var target = InstallDirectorySafety.NormalizeDirectory(installDirectory);
        var manifest = Read(target);
        if (manifest is null)
        {
            return "安装目录缺少安装清单，已只移除自启动。";
        }
        if (!string.Equals(manifest.App, AppName, StringComparison.Ordinal))
        {
            return "安装清单不属于本应用，已只移除自启动。";
        }
        if (!string.Equals(manifest.Scope, scope.ToString(), StringComparison.Ordinal))
        {
            return "安装清单的安装范围不匹配，已只移除自启动。";
        }
        if (!string.Equals(
                InstallDirectorySafety.NormalizeDirectory(manifest.InstallDirectory),
                target,
                StringComparison.OrdinalIgnoreCase))
        {
            return "安装目录与安装清单记录不一致，已只移除自启动。";
        }
        if (manifest.Files.Count == 0)
        {
            return "安装清单为空，已只移除自启动。";
        }
        return null;
    }

    public static string? ValidateRegistrySummary(
        InstallScope scope,
        string installDirectory,
        InstallRegistryRecord? record)
    {
        if (record is null)
        {
            return "注册表缺少安装记录，已只移除自启动。";
        }

        var summary = ReadSummary(installDirectory);
        if (summary is null)
        {
            return "安装目录缺少安装清单，已只移除自启动。";
        }

        if (!string.Equals(record.Scope, scope.ToString(), StringComparison.Ordinal) ||
            !string.Equals(record.InstallDirectory, summary.InstallDirectory, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(record.ManifestSha256, summary.ManifestSha256, StringComparison.OrdinalIgnoreCase))
        {
            return "安装清单与注册表记录不一致，已只移除自启动。";
        }
        return null;
    }

    public static ManifestRemovalResult RemoveInstalledFiles(InstallScope scope, string installDirectory)
    {
        var target = InstallDirectorySafety.NormalizeDirectory(installDirectory);
        var validation = ValidateForRemoval(scope, target);
        if (validation is not null)
        {
            return new ManifestRemovalResult(false, false, 0, 0, validation);
        }

        var manifest = Read(target)!;
        var deleted = 0;
        var skipped = 0;
        foreach (var entry in manifest.Files)
        {
            var file = ResolveManifestPath(target, entry.RelativePath);
            if (file is null)
            {
                skipped++;
                continue;
            }
            if (!File.Exists(file))
            {
                continue;
            }
            if (!FileMatchesEntry(file, entry))
            {
                skipped++;
                continue;
            }
            File.Delete(file);
            deleted++;
        }

        if (skipped == 0)
        {
            TryDeleteFile(ManifestPath(target));
        }

        InstallRuntimeArtifacts.RemoveEmptyDirectories(target);
        return new ManifestRemovalResult(
            skipped == 0,
            deleted > 0,
            deleted,
            skipped,
            skipped == 0 ? null : "部分文件已被修改，已保留这些文件和安装清单。");
    }

    private static InstallManifestEntry CreateEntry(string root, string file)
    {
        var info = new FileInfo(file);
        return new InstallManifestEntry(
            Path.GetRelativePath(root, file),
            info.Length,
            ComputeSha256(file));
    }

    private static InstallManifestDocument? Read(string installDirectory)
    {
        try
        {
            var path = ManifestPath(installDirectory);
            return File.Exists(path)
                ? JsonSerializer.Deserialize<InstallManifestDocument>(File.ReadAllText(path))
                : null;
        }
        catch
        {
            return null;
        }
    }

    private static bool FileMatchesEntry(string file, InstallManifestEntry entry)
    {
        var info = new FileInfo(file);
        return info.Length == entry.Length &&
            string.Equals(ComputeSha256(file), entry.Sha256, StringComparison.OrdinalIgnoreCase);
    }

    private static string? ResolveManifestPath(string root, string relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath) || Path.IsPathRooted(relativePath))
        {
            return null;
        }
        var target = InstallDirectorySafety.NormalizeDirectory(root);
        var candidate = Path.GetFullPath(Path.Combine(target, relativePath));
        return IsInsideDirectory(target, candidate) ? candidate : null;
    }

    private static bool IsInsideDirectory(string root, string candidate)
    {
        var rootWithSeparator = root.EndsWith(Path.DirectorySeparatorChar)
            ? root
            : root + Path.DirectorySeparatorChar;
        return candidate.StartsWith(rootWithSeparator, StringComparison.OrdinalIgnoreCase);
    }

    private static string ManifestPath(string installDirectory)
    {
        return Path.Combine(InstallDirectorySafety.NormalizeDirectory(installDirectory), ManifestFileName);
    }

    private static string ComputeSha256(string file)
    {
        using var stream = File.OpenRead(file);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
            // Leftover manifest is safer than deleting an unexpected file.
        }
    }

}
