package com.monika.dashboard.lsposed;

import android.os.Handler;
import android.os.Looper;

final class LspSystemServerScope {
    interface Host {
        void logWarn(String message);
        void logDebug(String message);
    }

    private final LspRuntimeEnvironment runtime;
    private final LspDirectFeature directFeature;
    private final LspBrowserFeature browserFeature;
    private final LspForegroundFeature foregroundFeature;
    private final LspMediaTracker mediaTracker;
    private final LspDeviceControlFeature deviceControlFeature;
    private final Host host;

    LspSystemServerScope(
            LspRuntimeEnvironment runtime,
            LspDirectFeature directFeature,
            LspBrowserFeature browserFeature,
            LspForegroundFeature foregroundFeature,
            LspMediaTracker mediaTracker,
            LspDeviceControlFeature deviceControlFeature,
            Host host) {
        this.runtime = runtime;
        this.directFeature = directFeature;
        this.browserFeature = browserFeature;
        this.foregroundFeature = foregroundFeature;
        this.mediaTracker = mediaTracker;
        this.deviceControlFeature = deviceControlFeature;
        this.host = host;
    }

    void start(ClassLoader classLoader) {
        runtime.markSystemServer();
        runtime.initUploadThread();
        Handler handler = new Handler(Looper.getMainLooper());
        scheduleReceivers(handler, 1500L);
        mediaTracker.installInternalHooks(classLoader);
        foregroundFeature.installHooks(classLoader);
    }

    void onForegroundSamplerStarted(Handler handler) {
        scheduleReceivers(handler, 10000L);
        deviceControlFeature.scheduleDailyCleanup(handler);
    }

    void scheduleReceivers(Handler handler, long delayMs) {
        if (handler == null || !runtime.systemServerProcess()) return;
        handler.postDelayed(() -> {
            try { directFeature.loadConfig(); } catch (Throwable t) { host.logWarn("deferred load config failed: " + t.getClass().getSimpleName()); }
            try { directFeature.registerConfigReceiver(handler); } catch (Throwable t) { host.logWarn("deferred register receiver failed: " + t.getClass().getSimpleName()); }
            try { browserFeature.registerReceiver(handler); } catch (Throwable t) { host.logWarn("deferred register browser title receiver failed: " + t.getClass().getSimpleName()); }
            try { foregroundFeature.registerScreenReceiver(handler); } catch (Throwable t) { host.logWarn("deferred register screen receiver failed: " + t.getClass().getSimpleName()); }
            try { mediaTracker.initSessionListener(); } catch (Throwable t) { host.logWarn("deferred init media listener failed: " + t.getClass().getSimpleName()); }
            try { foregroundFeature.snapshot(); } catch (Throwable t) { host.logDebug("deferred initial snapshot skipped: " + t.getClass().getSimpleName()); }
        }, Math.max(0L, delayMs));
    }
}
