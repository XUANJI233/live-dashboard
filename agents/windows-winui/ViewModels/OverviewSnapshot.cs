using LiveDashboardAgent.Services;

namespace LiveDashboardAgent.ViewModels;

public sealed record OverviewSnapshot(
    string RuntimeStatus,
    string CurrentTarget,
    string Server,
    string Autostart,
    string DistributionMode,
    string InstallDirectory,
    string CommandLine)
{
    public static OverviewSnapshot Create(AppConfig config, StartupManager startup)
    {
        var server = string.IsNullOrWhiteSpace(config.ServerUrl) ? "未配置" : config.ServerUrl;
        return new OverviewSnapshot(
            RuntimeStatus: config.Validate() is null ? "已配置" : "配置未完成",
            CurrentTarget: "暂无窗口",
            Server: server,
            Autostart: startup.IsEnabled() ? "已开启" : "未开启",
            DistributionMode: InstallationMode.Label,
            InstallDirectory: InstallationMode.DefaultInstallDirectory,
            CommandLine: startup.CurrentCommandLine());
    }
}
