namespace LiveDashboardAgent.Services;

internal sealed record RuntimeArtifactCleanupResult(
    int DeletedLogs,
    int SkippedLogs);

internal static class InstallRuntimeArtifacts
{
    public static RuntimeArtifactCleanupResult RemoveLogs(string installDirectory)
    {
        var target = InstallDirectorySafety.NormalizeDirectory(installDirectory);
        if (!Directory.Exists(target))
        {
            return new RuntimeArtifactCleanupResult(0, 0);
        }

        var deleted = 0;
        var skipped = 0;
        foreach (var file in Directory.EnumerateFiles(target, "*", SearchOption.AllDirectories))
        {
            if (!IsKnownLogFile(file))
            {
                continue;
            }

            try
            {
                File.Delete(file);
                deleted++;
            }
            catch
            {
                skipped++;
            }
        }
        RemoveEmptyDirectories(target);
        return new RuntimeArtifactCleanupResult(deleted, skipped);
    }

    public static void RemoveEmptyDirectories(string target)
    {
        if (!Directory.Exists(target))
        {
            return;
        }

        foreach (var directory in Directory
            .EnumerateDirectories(target, "*", SearchOption.AllDirectories)
            .OrderByDescending(path => path.Length))
        {
            TryDeleteEmptyDirectory(directory);
        }
        TryDeleteEmptyDirectory(target);
    }

    private static bool IsKnownLogFile(string file)
    {
        var name = Path.GetFileName(file);
        return string.Equals(name, "agent.log", StringComparison.OrdinalIgnoreCase) ||
            name.StartsWith("agent.log.", StringComparison.OrdinalIgnoreCase);
    }

    private static void TryDeleteEmptyDirectory(string path)
    {
        try
        {
            Directory.Delete(path, recursive: false);
        }
        catch
        {
            // Non-empty or locked directories are intentionally preserved.
        }
    }
}
