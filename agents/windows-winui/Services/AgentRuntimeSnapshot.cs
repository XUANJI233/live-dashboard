namespace LiveDashboardAgent.Services;

public sealed record AgentRuntimeSnapshot(
    string Status,
    string CurrentTarget,
    DateTimeOffset? LastReportAt,
    string LastError,
    bool IsRunning)
{
    public static AgentRuntimeSnapshot Stopped { get; } = new(
        "未启动",
        "暂无窗口",
        null,
        "",
        false);
}
