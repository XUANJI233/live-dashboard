package com.monika.dashboard.lsposed;

import android.os.Handler;

import org.json.JSONObject;

import java.util.List;

interface LspDeviceCommandHost {
    Handler uploadHandler();
    String directServerUrl();
    String directToken();
    void ensureWsConnected(String serverUrl, String token);
    boolean sendWsText(String text);
    boolean postAckHttp(String serverUrl, String token, String body);
    void logDebug(String message);
    String isoTime(long millis);
    long nextDailyUnfreezeAt(long now);
    JSONObject frozenState(long now);
    String foregroundPackage();
    String foregroundApp();
    String foregroundTitle();
    boolean isInstalledPackage(String packageName);
    List<LspInstalledApp> installedApps();
    List<LspFrozenPackage> frozenPackages();
    boolean unfreezePackage(String packageName);
    LspFreezeResult freezePackage(String packageName, String reason, long now, long until);
    boolean postSayNotification(String commandId, String text);
    boolean vibrate(long durationMs);
    void requestDirectUpload();
}

final class LspInstalledApp {
    final String packageName;
    final String label;

    LspInstalledApp(String packageName, String label) {
        this.packageName = packageName;
        this.label = label;
    }
}

final class LspFrozenPackage {
    final String packageName;
    final String appName;
    final String mode;
    final String reason;

    LspFrozenPackage(String packageName, String appName, String mode, String reason) {
        this.packageName = packageName;
        this.appName = appName;
        this.mode = mode;
        this.reason = reason;
    }
}

final class LspFreezeResult {
    final String packageName;
    final String appName;
    final String mode;
    final String status;
    final String reason;
    final long until;

    LspFreezeResult(
            String packageName,
            String appName,
            String mode,
            String status,
            String reason,
            long until) {
        this.packageName = packageName;
        this.appName = appName;
        this.mode = mode;
        this.status = status;
        this.reason = reason;
        this.until = until;
    }
}
