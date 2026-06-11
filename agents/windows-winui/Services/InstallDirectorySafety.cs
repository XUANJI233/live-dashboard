using System.Text.Json;

namespace LiveDashboardAgent.Services;

internal static class InstallDirectorySafety
{
    public const string MarkerFileName = ".live-dashboard-agent-install";

    public static string NormalizeDirectory(string path)
    {
        return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }

    public static bool TryNormalizeDirectory(string path, out string normalized, out string? error)
    {
        try
        {
            normalized = NormalizeDirectory(path);
            error = null;
            return true;
        }
        catch (Exception ex)
        {
            normalized = path;
            error = $"安装路径无效: {ex.Message}";
            return false;
        }
    }

    public static string? ValidateInstallTarget(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return "安装路径不能为空。";
        }
        return IsProtectedDirectory(path) ? "安装路径不能是磁盘根目录或系统目录。" : null;
    }

    public static string? ValidateRemovalTarget(InstallScope scope, string path)
    {
        if (IsProtectedDirectory(path))
        {
            return "安装路径不安全，已只移除自启动。";
        }
        return InstallManifestStore.ValidateForRemoval(scope, path);
    }

    public static void WriteInstallMarker(string target, InstallScope scope)
    {
        var marker = new
        {
            app = "LiveDashboardAgent",
            scope = scope.ToString(),
            installed_at = DateTimeOffset.UtcNow,
        };
        File.WriteAllText(
            Path.Combine(target, MarkerFileName),
            JsonSerializer.Serialize(marker));
    }

    public static bool HasInstallMarker(string path)
    {
        var markerPath = Path.Combine(path, MarkerFileName);
        try
        {
            if (!File.Exists(markerPath))
            {
                return false;
            }
            using var document = JsonDocument.Parse(File.ReadAllText(markerPath));
            return document.RootElement.TryGetProperty("app", out var app) &&
                string.Equals(app.GetString(), "LiveDashboardAgent", StringComparison.Ordinal);
        }
        catch
        {
            return false;
        }
    }

    public static bool IsChildDirectory(string parent, string candidate)
    {
        var normalizedParent = NormalizeDirectory(parent);
        var normalizedCandidate = NormalizeDirectory(candidate);
        if (string.Equals(normalizedParent, normalizedCandidate, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }
        var relative = Path.GetRelativePath(normalizedParent, normalizedCandidate);
        return !relative.StartsWith("..", StringComparison.Ordinal) &&
            !Path.IsPathRooted(relative);
    }

    private static bool IsProtectedDirectory(string path)
    {
        var fullPath = Path.GetFullPath(path);
        var normalized = TrimDirectoryEnd(fullPath);
        var root = Path.GetPathRoot(fullPath);
        if (!string.IsNullOrWhiteSpace(root) &&
            string.Equals(normalized, TrimDirectoryEnd(root), StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        var protectedPaths = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        };
        return protectedPaths
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Any(value => string.Equals(TrimDirectoryEnd(value), normalized, StringComparison.OrdinalIgnoreCase));
    }

    private static string TrimDirectoryEnd(string path)
    {
        return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }
}
