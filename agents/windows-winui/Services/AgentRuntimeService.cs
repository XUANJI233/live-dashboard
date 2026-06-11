namespace LiveDashboardAgent.Services;

public sealed class AgentRuntimeService
{
    private readonly object _lock = new();
    private readonly WindowsActivityProbe _activityProbe = new();
    private readonly DeviceMessageHistoryService _messageHistory;
    private CancellationTokenSource? _cancellation;
    private Task? _worker;
    private AgentRuntimeSnapshot _snapshot = AgentRuntimeSnapshot.Stopped;

    public AgentRuntimeService(DeviceMessageHistoryService messageHistory)
    {
        _messageHistory = messageHistory;
    }

    public AgentRuntimeSnapshot Snapshot
    {
        get
        {
            lock (_lock)
            {
                return _snapshot;
            }
        }
    }

    public void Start(AppConfig config)
    {
        Stop();

        var normalized = config.Normalize();
        var validation = normalized.Validate();
        if (validation is not null)
        {
            SetSnapshot(new AgentRuntimeSnapshot("配置未完成", "暂无窗口", null, validation, false));
            return;
        }

        var cancellation = new CancellationTokenSource();
        lock (_lock)
        {
            _cancellation = cancellation;
            _snapshot = new AgentRuntimeSnapshot("启动中", "暂无窗口", null, "", true);
            _worker = Task.Run(() => RunAsync(normalized, cancellation.Token), CancellationToken.None);
        }
        AgentLogService.Write(normalized, "runtime starting");
    }

    public void Restart(AppConfig config)
    {
        Start(config);
    }

    public void Stop()
    {
        CancellationTokenSource? cancellation;
        Task? worker;
        lock (_lock)
        {
            cancellation = _cancellation;
            worker = _worker;
            _cancellation = null;
            _worker = null;
        }

        if (cancellation is null)
        {
            return;
        }

        cancellation.Cancel();
        try
        {
            worker?.Wait(TimeSpan.FromSeconds(2));
        }
        catch
        {
            // Shutdown must not hang the UI thread.
        }
        finally
        {
            cancellation.Dispose();
        }
        SetSnapshot(Snapshot with { Status = "已停止", IsRunning = false });
    }

    private async Task RunAsync(AppConfig config, CancellationToken cancellationToken)
    {
        using var reporter = new ReportClient(config);
        var audioProbe = new TimedProbe<bool>(
            _activityProbe.IsAudioPlaying,
            TimeSpan.FromSeconds(10),
            false);
        var fullscreenProbe = new TimedProbe<bool>(
            _activityProbe.IsForegroundFullscreen,
            TimeSpan.FromSeconds(2),
            false);
        var musicProbe = new TimedProbe<MusicSnapshot?>(
            _activityProbe.GetMusicInfo,
            TimeSpan.FromSeconds(15),
            null);
        using var messageClient = new DeviceMessageClient(config);

        ForegroundWindowSnapshot? previous = null;
        var lastReportAt = DateTimeOffset.MinValue;
        var lastMessageFetchAt = DateTimeOffset.MinValue;
        var wasIdle = false;

        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var now = DateTimeOffset.UtcNow;
                var idleSeconds = _activityProbe.GetIdleSeconds();
                var isIdle = idleSeconds >= config.IdleThresholdSeconds &&
                    !audioProbe.Get() &&
                    !fullscreenProbe.Get();
                if (now - lastMessageFetchAt >= TimeSpan.FromSeconds(30))
                {
                    await FetchPendingMessagesAsync(messageClient, cancellationToken).ConfigureAwait(false);
                    lastMessageFetchAt = now;
                }

                if (isIdle)
                {
                    wasIdle = true;
                    var idleHeartbeatDue = now - lastReportAt >= TimeSpan.FromSeconds(config.HeartbeatSeconds);
                    if (idleHeartbeatDue)
                    {
                        var idleTarget = new ForegroundWindowSnapshot("idle", "User is away");
                        var sent = await SendReportAsync(reporter, idleTarget, null, cancellationToken)
                            .ConfigureAwait(false);
                        if (sent.Ok)
                        {
                            previous = idleTarget;
                            lastReportAt = now;
                            SetSnapshot(new AgentRuntimeSnapshot("AFK", idleTarget.DisplayText, now, "", true));
                        }
                        else
                        {
                            AgentLogService.Write(config, "report failed while idle: " + sent.Error);
                            SetSnapshot(new AgentRuntimeSnapshot("上报失败", idleTarget.DisplayText, Snapshot.LastReportAt, sent.Error, true));
                            await DelayRetryAsync(reporter, config, cancellationToken).ConfigureAwait(false);
                            continue;
                        }
                    }
                    else
                    {
                        SetSnapshot(Snapshot with { Status = "AFK", CurrentTarget = previous?.DisplayText ?? "idle" });
                    }

                    await DelayIntervalAsync(config, cancellationToken).ConfigureAwait(false);
                    continue;
                }

                if (wasIdle)
                {
                    wasIdle = false;
                    SetSnapshot(Snapshot with { Status = "在线" });
                }

                var current = _activityProbe.GetForegroundWindow();
                if (current is null)
                {
                    await DelayIntervalAsync(config, cancellationToken).ConfigureAwait(false);
                    continue;
                }

                SetSnapshot(Snapshot with { Status = "在线", CurrentTarget = current.DisplayText, LastError = "" });
                var changed = previous is null ||
                    !string.Equals(previous.AppId, current.AppId, StringComparison.Ordinal) ||
                    !string.Equals(previous.WindowTitle, current.WindowTitle, StringComparison.Ordinal);
                var heartbeatDue = now - lastReportAt >= TimeSpan.FromSeconds(config.HeartbeatSeconds);
                if (changed || heartbeatDue)
                {
                    var music = musicProbe.Get(force: changed);
                    var sent = await SendReportAsync(reporter, current, music, cancellationToken).ConfigureAwait(false);
                    if (sent.Ok)
                    {
                        previous = current;
                        lastReportAt = now;
                        SetSnapshot(new AgentRuntimeSnapshot("在线", current.DisplayText, now, "", true));
                    }
                    else
                    {
                        AgentLogService.Write(config, "report failed: " + sent.Error);
                        SetSnapshot(new AgentRuntimeSnapshot("上报失败", current.DisplayText, Snapshot.LastReportAt, sent.Error, true));
                        await DelayRetryAsync(reporter, config, cancellationToken).ConfigureAwait(false);
                        continue;
                    }
                }

                await DelayIntervalAsync(config, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                AgentLogService.Write(config, "runtime exception: " + ex);
                SetSnapshot(Snapshot with { Status = "运行异常", LastError = ex.Message, IsRunning = true });
                await DelayIntervalAsync(config, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private async Task<ReportResult> SendReportAsync(
        ReportClient reporter,
        ForegroundWindowSnapshot target,
        MusicSnapshot? music,
        CancellationToken cancellationToken)
    {
        var extra = DesktopDeviceProfile.WithCapabilities(_activityProbe.GetBatteryExtra());
        if (music is not null)
        {
            extra["music"] = music.ToExtra();
        }

        var payload = new ReportPayload(
            target.AppId,
            target.WindowTitle.Length > 256 ? target.WindowTitle[..256] : target.WindowTitle,
            DateTimeOffset.UtcNow.ToString("O"),
            extra);
        return await reporter.SendAsync(payload, cancellationToken).ConfigureAwait(false);
    }

    private async Task FetchPendingMessagesAsync(
        DeviceMessageClient messageClient,
        CancellationToken cancellationToken)
    {
        var messages = await messageClient.FetchPendingAsync(cancellationToken).ConfigureAwait(false);
        if (messages.Count == 0)
        {
            return;
        }

        var plainMessages = new List<DeviceMessage>();
        foreach (var message in messages)
        {
            if (DeviceCommandEnvelope.TryFromMessage(message, out var envelope) && envelope is not null)
            {
                await HandleDeviceCommandAsync(messageClient, envelope, cancellationToken).ConfigureAwait(false);
            }
            else
            {
                plainMessages.Add(message);
            }
        }

        if (plainMessages.Count > 0)
        {
            _messageHistory.AddIncoming(plainMessages);
        }
    }

    private async Task HandleDeviceCommandAsync(
        DeviceMessageClient messageClient,
        DeviceCommandEnvelope envelope,
        CancellationToken cancellationToken)
    {
        var receiptOk = await messageClient
            .SendCommandAckAsync(DeviceCommandExecutor.ReceiptFrame(envelope), cancellationToken)
            .ConfigureAwait(false);
        var execution = DeviceCommandExecutor.Execute(envelope);
        var resultOk = await messageClient
            .SendCommandAckAsync(execution.ResultFrame, cancellationToken)
            .ConfigureAwait(false);

        if (execution.DisplayMessage is not null)
        {
            _messageHistory.AddIncoming([execution.DisplayMessage]);
        }
        if (!receiptOk || !resultOk)
        {
            AgentLogService.Write(
                AppServices.ConfigStore.Load(),
                $"command ack failed: command_id={envelope.CommandId}, receipt={receiptOk}, result={resultOk}");
            SetSnapshot(Snapshot with
            {
                Status = "命令回执失败",
                LastError = $"receipt={receiptOk}, result={resultOk}",
            });
        }
    }

    private static Task DelayIntervalAsync(AppConfig config, CancellationToken cancellationToken)
    {
        return Task.Delay(TimeSpan.FromSeconds(config.IntervalSeconds), cancellationToken);
    }

    private static Task DelayRetryAsync(
        ReportClient reporter,
        AppConfig config,
        CancellationToken cancellationToken)
    {
        var delay = reporter.RetryDelay > TimeSpan.Zero
            ? reporter.RetryDelay
            : TimeSpan.FromSeconds(config.IntervalSeconds);
        return Task.Delay(delay, cancellationToken);
    }

    private void SetSnapshot(AgentRuntimeSnapshot snapshot)
    {
        lock (_lock)
        {
            _snapshot = snapshot;
        }
    }
}
