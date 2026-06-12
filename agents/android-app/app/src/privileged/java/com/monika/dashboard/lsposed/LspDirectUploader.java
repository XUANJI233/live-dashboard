package com.monika.dashboard.lsposed;

import android.content.Context;
import android.os.Handler;

import org.json.JSONObject;

final class LspDirectUploader {
    interface Host {
        boolean systemServerProcess();
        Handler uploadHandler();
        Context systemContext();
        void logWarn(String message);
        void logDebug(String message);
    }

    private final LspDirectConfig config;
    private final LspDirectReportBuilder reportBuilder;
    private final LspDirectTransport transport;
    private final LspDeviceCommandController deviceCommandController;
    private final Host host;
    private volatile long lastUploadAt = 0L;

    LspDirectUploader(
            LspDirectConfig config,
            LspDirectReportBuilder reportBuilder,
            LspDirectTransport transport,
            LspDeviceCommandController deviceCommandController,
            Host host) {
        this.config = config;
        this.reportBuilder = reportBuilder;
        this.transport = transport;
        this.deviceCommandController = deviceCommandController;
        this.host = host;
    }

    void request(boolean force) {
        if (!config.ready()) return;
        if (!host.systemServerProcess()) return;
        long now = System.currentTimeMillis();
        long safeInterval = Math.max(LspDirectConfig.MIN_INTERVAL_MS, config.intervalMs());
        if (!force && now - lastUploadAt < safeInterval) return;

        final String url = config.serverUrl();
        final String token = config.token();
        final long sampleAt = now;
        final boolean forceRequested = force;
        Handler handler = host.uploadHandler();
        if (handler == null) {
            host.logWarn("upload skipped: background handler unavailable");
            return;
        }
        lastUploadAt = now;
        handler.post(() -> upload(url, token, sampleAt, forceRequested));
    }

    private void upload(String url, String token, long sampleAt, boolean forceRequested) {
        deviceCommandController.flush(url, token);
        final String body = reportBuilder.build(sampleAt, forceRequested);
        if (body == null) return;

        try {
            JSONObject diag = new JSONObject(body);
            host.logDebug("upload: app_id=" + diag.optString("app_id")
                    + " title=" + diag.optString("window_title"));
        } catch (Throwable ignored) {}

        String pending = config.pendingBody();
        if (pending.length() > 0 && !pending.equals(body)) {
            if (transport.sendReport(url, token, pending)) {
                config.setPendingBody(host.systemContext(), "");
            } else {
                return;
            }
        }
        if (transport.sendReport(url, token, body)) {
            if (body.equals(config.pendingBody())) {
                config.setPendingBody(host.systemContext(), "");
            }
        } else {
            config.setPendingBody(host.systemContext(), body);
        }
    }
}
