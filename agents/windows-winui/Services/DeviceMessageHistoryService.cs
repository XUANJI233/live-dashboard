namespace LiveDashboardAgent.Services;

public sealed class DeviceMessageHistoryService
{
    private readonly DeviceMessageCache _cache = new();

    public IReadOnlyList<DeviceMessage> CachedMessages => _cache.Snapshot();

    public async Task<IReadOnlyList<DeviceMessage>> RefreshAsync(
        AppConfig config,
        CancellationToken cancellationToken = default)
    {
        using var client = new DeviceMessageClient(config);
        var history = await client.FetchHistoryAsync(cancellationToken: cancellationToken).ConfigureAwait(false);
        return _cache.Replace(history);
    }

    public IReadOnlyList<DeviceMessage> AddIncoming(IReadOnlyList<DeviceMessage> messages)
    {
        return _cache.PrependNew(messages);
    }
}
