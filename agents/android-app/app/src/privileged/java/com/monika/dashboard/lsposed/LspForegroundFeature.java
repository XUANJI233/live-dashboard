package com.monika.dashboard.lsposed;

import android.content.Context;
import android.os.Handler;

final class LspForegroundFeature {
    interface Host {
        Context systemContext();
        boolean screenInteractive();
        boolean ignoredPackage(String packageName);
        String resolveAppLabel(String packageName);
        LspMediaTracker.Snapshot mediaSnapshot();
        void onSamplerStarted(Handler handler);
        void onSnapshotComplete(boolean forceDirectUpload);
        void logInfo(String message);
        void logWarn(String message);
        void logDebug(String message);
    }

    private final LspForegroundTitleState titleState = new LspForegroundTitleState();
    private final LspForegroundReader reader;
    private final LspForegroundHooks hooks;
    private final LspForegroundReporter reporter;

    LspForegroundFeature(
            LspHookSupport hookSupport,
            String targetPackage,
            String targetReceiver,
            String configPermission,
            Host host) {
        reader = new LspForegroundReader(hookSupport, newReaderHost(host), targetPackage);
        hooks = new LspForegroundHooks(hookSupport, newHooksHost(host));
        reporter = new LspForegroundReporter(
                reader,
                titleState,
                targetPackage,
                targetReceiver,
                configPermission,
                newReporterHost(host));
    }

    LspForegroundReader reader() {
        return reader;
    }

    LspForegroundTitleState titleState() {
        return titleState;
    }

    String packageName() {
        return reporter.packageName();
    }

    String appName() {
        return reporter.appName();
    }

    String activityName() {
        return reporter.activityName();
    }

    String title() {
        return reporter.title();
    }

    void setBrowserForeground(String packageName, String appName, String activity) {
        reporter.setBrowserForeground(packageName, appName, activity);
    }

    String primaryDisplayTitle(boolean includeMedia) {
        return reporter.primaryDisplayTitle(includeMedia);
    }

    void installHooks(ClassLoader classLoader) {
        hooks.install(classLoader);
    }

    void registerScreenReceiver(Handler handler) {
        reporter.registerScreenReceiver(handler);
    }

    void snapshot() {
        reporter.snapshot();
    }

    private LspForegroundHooks.Host newHooksHost(Host host) {
        return new LspForegroundHooks.Host() {
            @Override
            public void startForegroundSampler() {
                reporter.startSampler();
            }

            @Override
            public void scheduleForegroundSnapshot(long delayMs) {
                reporter.scheduleSnapshot(delayMs);
            }

            @Override
            public void logInfo(String message) {
                host.logInfo(message);
            }

            @Override
            public void logWarn(String message) {
                host.logWarn(message);
            }

            @Override
            public void logDebug(String message) {
                host.logDebug(message);
            }
        };
    }

    private LspForegroundReader.Host newReaderHost(Host host) {
        return new LspForegroundReader.Host() {
            @Override
            public Context systemContext() {
                return host.systemContext();
            }

            @Override
            public boolean isIgnoredPackage(String packageName) {
                return host.ignoredPackage(packageName);
            }

            @Override
            public void logDebug(String message) {
                host.logDebug(message);
            }
        };
    }

    private LspForegroundReporter.Host newReporterHost(Host host) {
        return new LspForegroundReporter.Host() {
            @Override
            public Context systemContext() {
                return host.systemContext();
            }

            @Override
            public boolean screenInteractive() {
                return host.screenInteractive();
            }

            @Override
            public boolean ignoredPackage(String packageName) {
                return host.ignoredPackage(packageName);
            }

            @Override
            public String resolveAppLabel(String packageName) {
                return host.resolveAppLabel(packageName);
            }

            @Override
            public LspMediaTracker.Snapshot mediaSnapshot() {
                return host.mediaSnapshot();
            }

            @Override
            public void onSamplerStarted(Handler handler) {
                host.onSamplerStarted(handler);
            }

            @Override
            public void onSnapshotComplete(boolean forceDirectUpload) {
                host.onSnapshotComplete(forceDirectUpload);
            }

            @Override
            public void logInfo(String message) {
                host.logInfo(message);
            }

            @Override
            public void logWarn(String message) {
                host.logWarn(message);
            }

            @Override
            public void logDebug(String message) {
                host.logDebug(message);
            }
        };
    }
}
