namespace LiveDashboardAgent.Services;

public static class AppServices
{
    public static RegistryConfigStore ConfigStore { get; } = new();
    public static StartupManager StartupManager { get; } = new();
    public static UserInstallService UserInstallService { get; } = new();
}
