namespace LiveDashboardAgent.Services;

public static class RuntimeTargetFormatter
{
    public static string Format(string appId, string windowTitle)
    {
        var app = string.IsNullOrWhiteSpace(appId) ? "unknown" : appId.Trim();
        var title = (windowTitle ?? "").Trim();
        if (title.Length == 0 || string.Equals(title, app, StringComparison.OrdinalIgnoreCase))
        {
            return app;
        }
        return $"{app} - {TrimTitle(title)}";
    }

    private static string TrimTitle(string title)
    {
        return title.Length > 80 ? title[..80] : title;
    }
}
