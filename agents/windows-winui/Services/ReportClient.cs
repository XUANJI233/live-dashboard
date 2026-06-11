using System.Net.Http.Headers;
using System.Net.Http.Json;

namespace LiveDashboardAgent.Services;

public sealed class ReportClient : IDisposable
{
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan MaxBackoff = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan PauseDuration = TimeSpan.FromMinutes(5);
    private const int PauseAfterFailures = 5;

    private readonly HttpClient _httpClient;
    private readonly Uri _endpoint;
    private int _consecutiveFailures;
    private TimeSpan _currentBackoff = TimeSpan.Zero;
    private DateTimeOffset _pauseUntil = DateTimeOffset.MinValue;

    public ReportClient(AppConfig config)
    {
        var normalized = config.Normalize();
        _endpoint = new Uri(normalized.ServerUrl.TrimEnd('/') + "/api/report", UriKind.Absolute);
        _httpClient = new HttpClient
        {
            Timeout = RequestTimeout,
        };
        _httpClient.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", normalized.Token);
    }

    public TimeSpan RetryDelay => PauseRemaining > TimeSpan.Zero ? PauseRemaining : _currentBackoff;

    public async Task<ReportResult> SendAsync(ReportPayload payload, CancellationToken cancellationToken)
    {
        if (PauseRemaining > TimeSpan.Zero)
        {
            return ReportResult.Failed("上报暂停中。");
        }

        try
        {
            using var response = await _httpClient.PostAsJsonAsync(_endpoint, payload, cancellationToken)
                .ConfigureAwait(false);
            if ((int)response.StatusCode is 200 or 201 or 409)
            {
                _consecutiveFailures = 0;
                _currentBackoff = TimeSpan.Zero;
                _pauseUntil = DateTimeOffset.MinValue;
                return ReportResult.Sent();
            }

            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            RegisterFailure();
            return ReportResult.Failed($"HTTP {(int)response.StatusCode}: {body[..Math.Min(body.Length, 200)]}");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            RegisterFailure();
            return ReportResult.Failed(ex.Message);
        }
    }

    public void Dispose()
    {
        _httpClient.Dispose();
    }

    private TimeSpan PauseRemaining
    {
        get
        {
            var remaining = _pauseUntil - DateTimeOffset.UtcNow;
            if (remaining <= TimeSpan.Zero)
            {
                _pauseUntil = DateTimeOffset.MinValue;
                return TimeSpan.Zero;
            }
            return remaining;
        }
    }

    private void RegisterFailure()
    {
        _consecutiveFailures++;
        _currentBackoff = _currentBackoff == TimeSpan.Zero
            ? TimeSpan.FromSeconds(5)
            : TimeSpan.FromSeconds(Math.Min(_currentBackoff.TotalSeconds * 2, MaxBackoff.TotalSeconds));

        if (_consecutiveFailures < PauseAfterFailures)
        {
            return;
        }

        _pauseUntil = DateTimeOffset.UtcNow + PauseDuration;
        _consecutiveFailures = 0;
        _currentBackoff = TimeSpan.Zero;
    }
}

public sealed record ReportResult(bool Ok, string Error)
{
    public static ReportResult Sent() => new(true, "");
    public static ReportResult Failed(string error) => new(false, error);
}
