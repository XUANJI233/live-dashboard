namespace LiveDashboardAgent.Services;

public enum AgentDistributionMode
{
    Portable,
    UserInstall,
}

public static class InstallationMode
{
    public const string InstallDirectoryName = "LiveDashboardAgent";
    public const string InstallerMarkerFileName = ".live-dashboard-agent-installer";

    public static AgentDistributionMode Current => File.Exists(InstallerMarkerPath)
        ? AgentDistributionMode.UserInstall
        : AgentDistributionMode.Portable;

    public static string Label => Current == AgentDistributionMode.UserInstall ? "安装版" : "绿色版";

    public static string Description => Current == AgentDistributionMode.UserInstall
        ? "安装版用于首次安装或维护已安装实例，配置统一写入 HKCU 注册表。"
        : "便携版可从任意目录运行，但配置仍统一写入 HKCU 注册表，避免多个目录重复维护配置。";

    public static string DefaultInstallDirectory => DefaultInstallDirectoryFor(InstallScope.CurrentUser);

    public static string DefaultInstallDirectoryFor(InstallScope scope)
    {
        var root = scope == InstallScope.AllUsers
            ? Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles)
            : Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs");
        return Path.Combine(root, InstallDirectoryName);
    }

    public static string DirectoryInsideSelectedFolder(string selectedFolder)
    {
        var normalized = InstallDirectorySafety.NormalizeDirectory(selectedFolder);
        return string.Equals(
                Path.GetFileName(normalized),
                InstallDirectoryName,
                StringComparison.OrdinalIgnoreCase)
            ? normalized
            : Path.Combine(normalized, InstallDirectoryName);
    }

    public static string LabelFor(InstallScope scope)
    {
        return scope == InstallScope.AllUsers ? "所有用户" : "当前用户";
    }

    private static string InstallerMarkerPath
    {
        get
        {
            return Path.Combine(
                AppContext.BaseDirectory,
                InstallerMarkerFileName);
        }
    }
}
