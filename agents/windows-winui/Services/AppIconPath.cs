namespace LiveDashboardAgent.Services;

internal static class AppIconPath
{
    public static string Resolve()
    {
        return Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico");
    }
}
