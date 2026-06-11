namespace LiveDashboardAgent.Services;

public static class AppServices
{
    public static RegistryConfigStore ConfigStore { get; } = new();
    public static StartupManager StartupManager { get; } = new();
    public static UserInstallService UserInstallService { get; } = new();
    public static ElevatedInstallLauncher ElevatedInstallLauncher { get; } = new();
    public static InstallActionExecutor InstallActionExecutor { get; } = new(
        UserInstallService,
        ElevatedInstallLauncher);
}
