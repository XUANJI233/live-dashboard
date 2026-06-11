namespace LiveDashboardAgent.Services;

public sealed record UserInstallResult(bool Installed, bool Ok, string Message, string InstallDirectory);

public sealed class UserInstallService
{
    public string InstallDirectory => InstallationMode.DefaultInstallDirectory;

    public bool IsRunningFromInstallDirectory()
    {
        var current = NormalizeDirectory(AppContext.BaseDirectory);
        var install = NormalizeDirectory(InstallDirectory);
        return string.Equals(current, install, StringComparison.OrdinalIgnoreCase);
    }

    public UserInstallResult InstallCurrentUser()
    {
        if (InstallationMode.Current != AgentDistributionMode.UserInstall)
        {
            return new UserInstallResult(false, false, "当前版本是便携版。", InstallDirectory);
        }

        try
        {
            var source = NormalizeDirectory(AppContext.BaseDirectory);
            var target = NormalizeDirectory(InstallDirectory);
            Directory.CreateDirectory(target);

            if (!string.Equals(source, target, StringComparison.OrdinalIgnoreCase))
            {
                CopyDirectory(source, target);
            }

            var targetExe = Path.Combine(target, "LiveDashboardAgent.exe");
            if (!File.Exists(targetExe))
            {
                return new UserInstallResult(false, false, "安装目录缺少主程序。", target);
            }

            var startup = new StartupManager(targetExe);
            var startupResult = startup.SetEnabled(true);
            return new UserInstallResult(
                startupResult.Enabled,
                startupResult.Ok,
                startupResult.Ok ? "已安装到当前用户目录。" : startupResult.Message,
                target);
        }
        catch (Exception ex)
        {
            return new UserInstallResult(false, false, ex.Message, InstallDirectory);
        }
    }

    private static void CopyDirectory(string source, string target)
    {
        foreach (var directory in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(source, directory);
            Directory.CreateDirectory(Path.Combine(target, relative));
        }

        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(source, file);
            var destination = Path.Combine(target, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            File.Copy(file, destination, overwrite: true);
        }
    }

    private static string NormalizeDirectory(string path)
    {
        return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }
}
