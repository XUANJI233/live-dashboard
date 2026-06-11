namespace LiveDashboardAgent.Services;

public sealed class DeviceMessageCache
{
    private const int DefaultLimit = 100;
    private readonly object _lock = new();
    private List<DeviceMessage> _items = [];

    public IReadOnlyList<DeviceMessage> Replace(IReadOnlyList<DeviceMessage> incoming, int limit = DefaultLimit)
    {
        lock (_lock)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            _items = incoming
                .Where(message => !message.IsDeviceCommand)
                .Reverse()
                .Where(message => seen.Add(message.MessageId))
                .Take(limit)
                .ToList();
            return _items.ToList();
        }
    }

    public IReadOnlyList<DeviceMessage> PrependNew(IReadOnlyList<DeviceMessage> incoming, int limit = DefaultLimit)
    {
        lock (_lock)
        {
            var merged = _items.ToList();
            var seen = new HashSet<string>(
                merged.Select(message => message.MessageId),
                StringComparer.Ordinal);
            foreach (var message in incoming.Reverse())
            {
                if (!seen.Add(message.MessageId))
                {
                    continue;
                }
                merged.Insert(0, message);
            }
            _items = merged.Take(limit).ToList();
            return _items.ToList();
        }
    }

    public IReadOnlyList<DeviceMessage> Snapshot()
    {
        lock (_lock)
        {
            return _items.ToList();
        }
    }
}
