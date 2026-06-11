namespace LiveDashboardAgent.Services;

public sealed class InstallActionExecutor(
    UserInstallService installService,
    ElevatedInstallLauncher elevatedLauncher)
{
    public async Task<InstallResult> Execute(
        InstallAction action,
        InstallScope scope,
        string installDirectory,
        bool removeLogs = false,
        bool createDesktopShortcut = false)
    {
        if (installService.RequiresElevation(scope))
        {
            return await elevatedLauncher.Run(
                new InstallCommandOptions(
                    action,
                    scope,
                    installDirectory,
                    ParentProcessId: Environment.ProcessId,
                    RemoveLogs: removeLogs,
                    CreateDesktopShortcut: createDesktopShortcut));
        }

        return await Task.Run(() => action switch
        {
            InstallAction.Install => installService.Install(
                new InstallOptions(scope, installDirectory, createDesktopShortcut)),
            InstallAction.Uninstall => installService.Uninstall(
                new UninstallOptions(scope, installDirectory, Environment.ProcessId, removeLogs)),
            _ => new InstallResult(false, false, "未知安装动作。", installDirectory),
        });
    }
}
