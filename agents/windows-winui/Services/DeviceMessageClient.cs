using System.Net.Http.Headers;
using System.Net.Http.Json;

namespace LiveDashboardAgent.Services;

public sealed class DeviceMessageClient : IDisposable
{
    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(15);
    private readonly HttpClient _httpClient;
    private readonly string _serverUrl;
    private readonly string _token;

    public DeviceMessageClient(AppConfig config)
    {
        var normalized = config.Normalize();
        _serverUrl = normalized.ServerUrl.TrimEnd('/');
        _token = normalized.Token;
        _httpClient = new HttpClient
        {
            Timeout = DefaultTimeout,
        };
    }

    public async Task<IReadOnlyList<DeviceMessage>> FetchHistoryAsync(
        string since = "",
        CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, HistoryEndpoint(since));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);

        using var response = await _httpClient
            .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
            .ConfigureAwait(false);
        var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new DeviceMessageClientException(
                $"消息历史请求失败: HTTP {(int)response.StatusCode} {response.ReasonPhrase}".Trim(),
                (int)response.StatusCode,
                body);
        }

        return DeviceMessageResponseParser.Parse(body);
    }

    public async Task<IReadOnlyList<DeviceMessage>> FetchPendingAsync(
        CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            new Uri(_serverUrl + "/api/messages", UriKind.Absolute));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);

        using var response = await _httpClient
            .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
            .ConfigureAwait(false);
        var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new DeviceMessageClientException(
                $"待处理消息请求失败: HTTP {(int)response.StatusCode} {response.ReasonPhrase}".Trim(),
                (int)response.StatusCode,
                body);
        }

        return DeviceMessageResponseParser.Parse(body);
    }

    public async Task<bool> SendCommandAckAsync(
        IReadOnlyDictionary<string, object?> frame,
        CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            new Uri(_serverUrl + "/api/supervision/ack", UriKind.Absolute));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
        request.Content = JsonContent.Create(frame);

        using var response = await _httpClient.SendAsync(request, cancellationToken).ConfigureAwait(false);
        return response.IsSuccessStatusCode;
    }

    public void Dispose()
    {
        _httpClient.Dispose();
    }

    private Uri HistoryEndpoint(string since)
    {
        var suffix = "/api/messages/history";
        if (!string.IsNullOrWhiteSpace(since))
        {
            suffix += "?since=" + Uri.EscapeDataString(since);
        }
        return new Uri(_serverUrl + suffix, UriKind.Absolute);
    }
}

public sealed class DeviceMessageClientException : Exception
{
    public DeviceMessageClientException(string message, int statusCode, string responseBody)
        : base(message)
    {
        StatusCode = statusCode;
        ResponseBody = responseBody;
    }

    public int StatusCode { get; }
    public string ResponseBody { get; }
}
