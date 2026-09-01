package com.monika.dashboard.lsposed;

final class LspDirectOfflineTimeoutPolicy {
    static final String FIELD = "offline_timeout_minutes";

    private static final int MAX_REPORTED_MINUTES = 60;
    private static final int GRACE_MINUTES = 2;

    private LspDirectOfflineTimeoutPolicy() {}

    static int forReport(
            boolean sleeping,
            long heartbeatMs,
            long minimumUploadMs,
            long configuredUploadMs) {
        long activeCadenceMs = Math.max(minimumUploadMs, configuredUploadMs);
        long cadenceMs = sleeping ? Math.max(heartbeatMs, activeCadenceMs) : activeCadenceMs;
        long cadenceMinutes = Math.max(1L, (Math.max(1L, cadenceMs) + 59_999L) / 60_000L);
        return (int) Math.min(MAX_REPORTED_MINUTES, cadenceMinutes + GRACE_MINUTES);
    }
}
