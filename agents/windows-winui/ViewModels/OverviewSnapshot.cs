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
    public static OverviewSnapshot Create(
        AppConfig config,
        StartupManager startup,
        AgentRuntimeSnapshot runtime)
    {
        var server = string.IsNullOrWhiteSpace(config.ServerUrl) ? "未配置" : config.ServerUrl;
        var runningInstall = AppServices.UserInstallService.GetRunningInstall();
        var mode = runningInstall is null
            ? InstallationMode.Label
            : $"{InstallationMode.LabelFor(runningInstall.Scope)}安装版";
        var directory = runningInstall?.InstallDirectory ??
            AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return new OverviewSnapshot(
            RuntimeStatus: RuntimeStatusText(config, runtime),
            CurrentTarget: runtime.CurrentTarget,
            Server: server,
            Autostart: startup.IsEnabled() ? "已开启" : "未开启",
            DistributionMode: mode,
            RuntimeDirectory: directory,
            CommandLine: startup.CurrentCommandLine());
    }

    private static string RuntimeStatusText(AppConfig config, AgentRuntimeSnapshot runtime)
    {
        var validation = config.Validate();
        if (validation is not null)
        {
            return "配置未完成";
        }

        if (!string.IsNullOrWhiteSpace(runtime.LastError))
        {
            return $"{runtime.Status}: {runtime.LastError}";
        }
        if (runtime.LastReportAt is { } lastReport)
        {
            return $"{runtime.Status} · 上次上报 {lastReport.ToLocalTime():HH:mm:ss}";
        }
        return runtime.Status;
    }
}
