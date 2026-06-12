package com.monika.dashboard.lsposed;

import org.json.JSONArray;
import org.json.JSONObject;

final class LspDirectReportBuilder {
    interface Host {
        long heartbeatMs();
        long minDirectUploadMs();
        long directIntervalMs();
        boolean uploadForeground();
        boolean uploadMedia();
        boolean uploadNetwork();
        boolean uploadVpn();
        String foregroundPackage();
        String foregroundApp();
        String foregroundActivity();
        String foregroundTitle();
        String primaryDisplayTitle();
        boolean supervisionCheckRequested();
        String isoTime(long millis);
        void logWarn(String message);
    }

    private static final String OFFLINE_TIMEOUT_FIELD = "offline_timeout_minutes";
    private static final int MAX_REPORTED_OFFLINE_TIMEOUT_MINUTES = 60;
    private static final int REPORTED_OFFLINE_TIMEOUT_GRACE_MINUTES = 2;
    private static final long DIRECT_FULL_STATE_INTERVAL_MS = 5 * 60_000L;

    private final LspMediaTracker mediaTracker;
    private final LspForegroundReader foregroundReader;
    private final LspDeviceEnvironment deviceEnvironment;
    private final LspDeviceControlFeature deviceControlFeature;
    private final LspInstalledAppsReporter installedAppsReporter;
    private final Host host;
    private volatile String lastStateSignature = "";
    private volatile long lastFullReportAt = 0L;

    LspDirectReportBuilder(
            LspMediaTracker mediaTracker,
            LspForegroundReader foregroundReader,
            LspDeviceEnvironment deviceEnvironment,
            LspDeviceControlFeature deviceControlFeature,
            LspInstalledAppsReporter installedAppsReporter,
            Host host) {
        this.mediaTracker = mediaTracker;
        this.foregroundReader = foregroundReader;
        this.deviceEnvironment = deviceEnvironment;
        this.deviceControlFeature = deviceControlFeature;
        this.installedAppsReporter = installedAppsReporter;
        this.host = host;
    }

    String build(long now, boolean forceRequested) {
        try {
            boolean uploadMedia = host.uploadMedia();
            mediaTracker.validateIfNeeded(now, uploadMedia);
            LspMediaTracker.Snapshot media = mediaTracker.snapshot();
            String foregroundPackage = safeString(host.foregroundPackage());
            String appId = host.uploadForeground() ? foregroundPackage : "";
            boolean foregroundCanYieldToMedia =
                    appId.length() == 0 || "idle".equals(appId) || "sleeping".equals(appId);
            if (foregroundCanYieldToMedia) {
                if (uploadMedia && media.playing && media.packageName.length() > 0) {
                    appId = media.packageName;
                } else if (appId.length() == 0) {
                    appId = "idle";
                }
            }

            JSONObject extra = new JSONObject();
            deviceEnvironment.putBatteryExtras(extra);
            JSONObject device = new JSONObject();
            boolean sleeping = "sleeping".equals(foregroundPackage);
            device.put("profile", "android_lsp");
            device.put("capabilities", capabilitiesJson());
            device.put("last_sample_at", host.isoTime(now));
            device.put("energy_policy", "system_server_direct");
            device.put("min_interval_ms", Math.max(host.minDirectUploadMs(), host.directIntervalMs()));
            if (sleeping) {
                device.put(OFFLINE_TIMEOUT_FIELD, directOfflineTimeoutMinutes());
            }
            if (host.supervisionCheckRequested()) {
                device.put("supervision_check_requested", true);
            }
            device.put("device_kind", foregroundReader.deviceFormFactor());
            String wm = foregroundReader.windowingMode();
            if (wm != null) device.put("window_mode", wm);
            deviceEnvironment.putNetworkExtras(device, host.uploadNetwork(), host.uploadVpn());
            deviceEnvironment.putAudioOutputExtras(device);
            deviceEnvironment.putAmbientLightExtras(device, now);
            boolean heartbeatOnly = shouldSendHeartbeatOnly(now, forceRequested, media);
            if (heartbeatOnly) {
                device.put("heartbeat_only", true);
            }
            JSONArray frozen = deviceControlFeature.frozenPackagesJson(now);
            if (frozen.length() > 0) device.put("frozen_packages", frozen);
            installedAppsReporter.putIfDue(device, now, heartbeatOnly);
            extra.put("device", device);
            extra.put("sleeping", sleeping);
            putForeground(extra, foregroundPackage);
            if (uploadMedia) media.putReportMedia(extra);
            return new JSONObject()
                    .put("app_id", appId)
                    .put("window_title", host.primaryDisplayTitle())
                    .put("timestamp", host.isoTime(now))
                    .put("extra", extra)
                    .toString();
        } catch (Throwable t) {
            host.logWarn("build direct body failed: " + t.getClass().getSimpleName());
            return null;
        }
    }

    private void putForeground(JSONObject extra, String foregroundPackage) throws Exception {
        if (!host.uploadForeground() || foregroundPackage.length() == 0 || "idle".equals(foregroundPackage)) {
            return;
        }
        JSONObject foreground = new JSONObject();
        String app = safeString(host.foregroundApp());
        String activity = safeString(host.foregroundActivity());
        String title = safeString(host.foregroundTitle());
        foreground.put("package_name", foregroundPackage);
        if (app.length() > 0) foreground.put("app_name", app);
        if (activity.length() > 0) foreground.put("activity", activity);
        if (title.length() > 0 || LspBrowserTitle.isBrowserPackage(foregroundPackage)) {
            foreground.put("title", title);
        }
        foreground.put("source", "lsposed");
        foreground.put("confidence", 0.95);
        extra.put("foreground", foreground);
    }

    private JSONObject capabilitiesJson() {
        JSONObject capabilities = new JSONObject();
        try {
            capabilities.put("freeze", true);
            capabilities.put("unfreeze", true);
            capabilities.put("vibrate", true);
            capabilities.put("screen_off", false);
            capabilities.put("say", true);
            capabilities.put("risk_app_monitor", true);
            capabilities.put("app_time_limit", true);
        } catch (Throwable ignored) {}
        return capabilities;
    }

    private int directOfflineTimeoutMinutes() {
        long cadenceMs = Math.max(host.heartbeatMs(), Math.max(host.minDirectUploadMs(), host.directIntervalMs()));
        long cadenceMinutes = Math.max(1L, (cadenceMs + 59_999L) / 60_000L);
        long timeoutMinutes = cadenceMinutes + REPORTED_OFFLINE_TIMEOUT_GRACE_MINUTES;
        return (int) Math.min(MAX_REPORTED_OFFLINE_TIMEOUT_MINUTES, timeoutMinutes);
    }

    private boolean shouldSendHeartbeatOnly(long now, boolean forceRequested, LspMediaTracker.Snapshot media) {
        String signature = directStateSignature(media);
        if (forceRequested || signature.length() == 0 || !signature.equals(lastStateSignature)) {
            lastStateSignature = signature;
            lastFullReportAt = now;
            return false;
        }
        if (lastFullReportAt <= 0L || now - lastFullReportAt >= DIRECT_FULL_STATE_INTERVAL_MS) {
            lastFullReportAt = now;
            return false;
        }
        return true;
    }

    private String directStateSignature(LspMediaTracker.Snapshot media) {
        return safeString(host.foregroundPackage()) + "|" +
                safeString(host.foregroundTitle()) + "|" +
                media.signaturePart();
    }

    private static String safeString(String value) {
        return value != null ? value.trim() : "";
    }
}
