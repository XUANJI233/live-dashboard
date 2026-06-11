namespace LiveDashboardAgent.Services;

public enum AgentDistributionMode
{
    Portable,
    UserInstall,
}

public static class InstallationMode
{
    public static AgentDistributionMode Current
    {
        get
        {
#if LIVE_DASHBOARD_USER_INSTALL
            return AgentDistributionMode.UserInstall;
#else
            return AgentDistributionMode.Portable;
#endif
        }
    }

    public static string Label => Current == AgentDistributionMode.UserInstall ? "当前用户安装版" : "便携版";

    public static string Description => Current == AgentDistributionMode.UserInstall
        ? "安装版固定在当前用户目录运行，配置与自启动统一写入 HKCU 注册表。"
        : "便携版可从任意目录运行，但配置仍统一写入 HKCU 注册表，避免多个目录重复维护配置。";

    public static string DefaultInstallDirectory =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LiveDashboardAgent");
}
