namespace LiveDashboardAgent.Services;

internal static class InstallFileCopier
{
    public static IReadOnlyList<string> CopyDirectory(string source, string target)
    {
        var copiedFiles = new List<string>();
        foreach (var directory in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(source, directory);
            Directory.CreateDirectory(Path.Combine(target, relative));
        }

        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            if (ShouldSkipInstallFile(file))
            {
                continue;
            }
            var relative = Path.GetRelativePath(source, file);
            var destination = Path.Combine(target, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            File.Copy(file, destination, overwrite: true);
            copiedFiles.Add(relative);
        }
        return copiedFiles;
    }

    private static bool ShouldSkipInstallFile(string file)
    {
        var name = Path.GetFileName(file);
        return string.Equals(name, InstallManifestStore.ManifestFileName, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(name, InstallDirectorySafety.MarkerFileName, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(name, InstallationMode.InstallerMarkerFileName, StringComparison.OrdinalIgnoreCase);
    }
}
