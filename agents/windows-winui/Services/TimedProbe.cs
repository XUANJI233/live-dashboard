namespace LiveDashboardAgent.Services;

public sealed class TimedProbe<T>
{
    private readonly Func<T> _probe;
    private readonly TimeSpan _ttl;
    private readonly T _fallback;
    private readonly TimeProvider _timeProvider;
    private T _value;
    private DateTimeOffset _expiresAt;

    public TimedProbe(Func<T> probe, TimeSpan ttl, T fallback, TimeProvider? timeProvider = null)
    {
        _probe = probe;
        _ttl = ttl < TimeSpan.Zero ? TimeSpan.Zero : ttl;
        _fallback = fallback;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _value = fallback;
        _expiresAt = DateTimeOffset.MinValue;
    }

    public T Get(bool force = false)
    {
        var now = _timeProvider.GetUtcNow();
        if (!force && now < _expiresAt)
        {
            return _value;
        }

        try
        {
            _value = _probe();
        }
        catch
        {
            _value = _fallback;
        }
        _expiresAt = now + _ttl;
        return _value;
    }
}
