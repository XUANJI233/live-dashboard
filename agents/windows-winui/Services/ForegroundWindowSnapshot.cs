namespace LiveDashboardAgent.Services;

public sealed record ForegroundWindowSnapshot(
    string AppId,
    string WindowTitle)
{
    public string DisplayText => RuntimeTargetFormatter.Format(AppId, WindowTitle);
}

public sealed record MusicSnapshot(
    string App,
    string Title,
    string Artist)
{
    public Dictionary<string, object> ToExtra()
    {
        var value = new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["app"] = App,
        };
        if (!string.IsNullOrWhiteSpace(Title))
        {
            value["title"] = Title.Length > 256 ? Title[..256] : Title;
        }
        if (!string.IsNullOrWhiteSpace(Artist))
        {
            value["artist"] = Artist.Length > 256 ? Artist[..256] : Artist;
        }
        return value;
    }
}
