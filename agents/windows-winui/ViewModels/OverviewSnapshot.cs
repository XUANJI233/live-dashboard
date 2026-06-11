using LiveDashboardAgent.Services;

namespace LiveDashboardAgent.ViewModels;

public sealed record OverviewSnapshot(
    string RuntimeStatus,
    string CurrentTarget,
    string Server,
    string Autostart,
    string DistributionMode,
    string RuntimeDirectory,
    string CommandLine)
{
    public static OverviewSnapshot Create(AppConfig config, StartupManager startup)
    {
        var server = string.IsNullOrWhiteSpace(config.ServerUrl) ? "未配置" : config.ServerUrl;
        var runningInstall = AppServices.UserInstallService.GetRunningInstall();
        var mode = runningInstall is null
            ? InstallationMode.Label
            : $"{InstallationMode.LabelFor(runningInstall.Scope)}安装版";
        var directory = runningInstall?.InstallDirectory ??
            AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return new OverviewSnapshot(
            RuntimeStatus: config.Validate() is null ? "已配置" : "配置未完成",
            CurrentTarget: "暂无窗口",
            Server: server,
            Autostart: startup.IsEnabled() ? "已开启" : "未开启",
            DistributionMode: mode,
            RuntimeDirectory: directory,
            CommandLine: startup.CurrentCommandLine());
    }
}
