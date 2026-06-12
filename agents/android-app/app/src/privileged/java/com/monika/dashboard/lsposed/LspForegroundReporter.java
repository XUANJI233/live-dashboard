package com.monika.dashboard.lsposed;

import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

final class LspForegroundReporter {
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

    private static final String ACTION_STATUS = "com.monika.dashboard.LSPOSED_STATUS";
    private static final long HEARTBEAT_MS = 5 * 60_000L;
    private static final long BROADCAST_DEBOUNCE_MS = 1500L;
    private static final long IDLE_DEBOUNCE_COUNT = 2;
    private static final long SCREEN_OFF_DEBOUNCE_MS = 30_000L;

    private static final class SnapshotDecision {
        final boolean applied;
        final boolean forceDirectUpload;

        SnapshotDecision(boolean applied, boolean forceDirectUpload) {
            this.applied = applied;
            this.forceDirectUpload = forceDirectUpload;
        }
    }

    private final LspForegroundReader foregroundReader;
    private final LspForegroundTitleState titleState;
    private final String targetPackage;
    private final String targetReceiver;
    private final String configPermission;
    private final Host host;
    private volatile int idleConsecutiveCount = 0;
    private volatile boolean snapshotPending = false;
    private volatile boolean samplerStarted = false;
    private volatile boolean screenReceiverRegistered = false;
    private volatile String lastForegroundKey = "";
    private volatile long lastForegroundBroadcastAt = 0L;
    private volatile String packageName = "";
    private volatile String appName = "";
    private volatile String activityName = "";
    private volatile long lastScreenOffCheckAt = 0L;

    LspForegroundReporter(
            LspForegroundReader foregroundReader,
            LspForegroundTitleState titleState,
            String targetPackage,
            String targetReceiver,
            String configPermission,
            Host host) {
        this.foregroundReader = foregroundReader;
        this.titleState = titleState;
        this.targetPackage = targetPackage;
        this.targetReceiver = targetReceiver;
        this.configPermission = configPermission;
        this.host = host;
    }

    String packageName() {
        return packageName;
    }

    String appName() {
        return appName;
    }

    String activityName() {
        return activityName;
    }

    String title() {
        return titleState.title();
    }

    void setBrowserForeground(String nextPackageName, String nextAppName, String nextActivityName) {
        packageName = safeString(nextPackageName);
        appName = safeString(nextAppName);
        activityName = safeString(nextActivityName);
    }

    void scheduleSnapshot(long delayMs) {
        if (snapshotPending) return;
        snapshotPending = true;
        try {
            Handler handler = new Handler(Looper.getMainLooper());
            handler.postDelayed(() -> {
                snapshotPending = false;
                try { snapshot(); } catch (Throwable ignored) {}
            }, Math.max(0L, delayMs));
        } catch (Throwable ignored) {
            snapshotPending = false;
            try { snapshot(); } catch (Throwable ignoredAgain) {}
        }
    }

    void forceSnapshot() {
        snapshotPending = false;
        scheduleSnapshot(0L);
    }

    void startSampler() {
        if (samplerStarted) return;
        try {
            Handler handler = new Handler(Looper.getMainLooper());
            samplerStarted = true;
            host.onSamplerStarted(handler);
            handler.postDelayed(new Runnable() {
                @Override
                public void run() {
                    try {
                        snapshot();
                    } catch (Throwable t) {
                        host.logWarn("foreground sample failed: " + t.getClass().getSimpleName());
                    } finally {
                        handler.postDelayed(this, HEARTBEAT_MS);
                    }
                }
            }, 15000L);
        } catch (Throwable t) {
            host.logWarn("foreground sampler failed: " + t.getClass().getSimpleName());
        }
    }

    void registerScreenReceiver(Handler handler) {
        if (screenReceiverRegistered) return;
        Context context = host.systemContext();
        if (context == null) return;
        try {
            IntentFilter filter = new IntentFilter();
            filter.addAction(Intent.ACTION_SCREEN_OFF);
            filter.addAction(Intent.ACTION_SCREEN_ON);
            BroadcastReceiver receiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context ctx, Intent intent) {
                    String action = intent != null ? intent.getAction() : null;
                    if (Intent.ACTION_SCREEN_OFF.equals(action)) {
                        lastScreenOffCheckAt = 0L;
                        handler.post(() -> {
                            try { snapshot(); } catch (Throwable ignored) {}
                        });
                    } else if (Intent.ACTION_SCREEN_ON.equals(action)) {
                        lastForegroundKey = "";
                        lastScreenOffCheckAt = 0L;
                        handler.postDelayed(() -> {
                            try { snapshot(); } catch (Throwable ignored) {}
                        }, 500L);
                    }
                }
            };
            if (Build.VERSION.SDK_INT >= 34) {
                context.registerReceiver(receiver, filter, null, handler, Context.RECEIVER_EXPORTED);
            } else if (Build.VERSION.SDK_INT >= 33) {
                context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
            } else {
                context.registerReceiver(receiver, filter, null, handler);
            }
            screenReceiverRegistered = true;
            host.logInfo("registered screen state receiver");
        } catch (Throwable t) {
            host.logWarn("screen receiver failed: " + t.getClass().getSimpleName());
        }
    }

    void snapshot() {
        try {
            long now = System.currentTimeMillis();
            boolean forceDirectUpload = false;

            if (!host.screenInteractive()) {
                if (now - lastScreenOffCheckAt < SCREEN_OFF_DEBOUNCE_MS) return;
                lastScreenOffCheckAt = now;
                if ("sleeping".equals(lastForegroundKey)
                        && now - lastForegroundBroadcastAt < BROADCAST_DEBOUNCE_MS) return;
                lastForegroundKey = "sleeping";
                lastForegroundBroadcastAt = now;
                idleConsecutiveCount = 0;
                packageName = "sleeping";
                appName = "sleeping";
                activityName = "";
                titleState.apply("", "sleep");
                host.logInfo("screen off -> sleeping");
                forceDirectUpload = true;
                Intent sleepIntent = baseStatusIntent();
                sleepIntent.putExtra("package_name", "sleeping");
                sleepIntent.putExtra("app_name", "sleeping");
                sleepIntent.putExtra("activity", "");
                host.mediaSnapshot().putIntentExtras(sleepIntent);
                sendStatus(sleepIntent);
                host.onSnapshotComplete(forceDirectUpload);
                return;
            }
            if ("sleeping".equals(lastForegroundKey)) {
                lastForegroundKey = "";
                host.logInfo("screen on -> waking from sleep");
            }

            ComponentName top = foregroundReader.topActivity();
            boolean idleCandidate = top == null || host.ignoredPackage(top.getPackageName());
            String taskDescription = taskDescriptionIfNeeded(top, idleCandidate);

            if (idleCandidate) {
                SnapshotDecision decision = applyIdle(now);
                if (!decision.applied) return;
                forceDirectUpload = decision.forceDirectUpload;
            } else {
                SnapshotDecision decision = applyForeground(top, taskDescription, now);
                if (!decision.applied) return;
                forceDirectUpload = decision.forceDirectUpload;
            }

            Intent intent = baseStatusIntent();
            if (idleCandidate) {
                intent.putExtra("package_name", "idle");
                intent.putExtra("app_name", "idle");
                intent.putExtra("activity", "");
            } else {
                intent.putExtra("package_name", packageName);
                intent.putExtra("app_name", appName);
                intent.putExtra("activity", activityName);
                if (titleState.title().length() > 0 || LspBrowserTitle.isBrowserPackage(packageName)) {
                    intent.putExtra("title", titleState.title());
                }
            }
            host.mediaSnapshot().putIntentExtras(intent);
            sendStatus(intent);
            host.onSnapshotComplete(forceDirectUpload);
        } catch (Throwable t) {
            host.logWarn("broadcast failed: " + t.getClass().getSimpleName());
        }
    }

    String primaryDisplayTitle(boolean includeMediaConfig) {
        LspMediaTracker.Snapshot media = host.mediaSnapshot();
        boolean includeMedia = includeMediaConfig && media.playing;
        if ("sleeping".equals(packageName)) {
            if (includeMedia && media.appName.length() > 0) {
                return media.title.length() > 0
                        ? media.appName + "正在播放" + media.title
                        : media.appName + "正在播放";
            }
            return "(-.-)zzZ";
        }
        boolean foregroundValid = appName.length() > 0
                && !"idle".equals(packageName)
                && !"idle".equals(appName);
        if (foregroundValid
                && includeMedia
                && media.title.length() > 0
                && media.appName.length() > 0
                && !media.appName.equals(appName)) {
            return "正在用" + appName + "，后台" + media.appName + "正在播放" + media.title;
        }
        if (foregroundValid && includeMedia && media.title.length() > 0) {
            return "正在用" + appName + "播放" + media.title;
        }
        if (!foregroundValid && includeMedia && media.title.length() > 0 && media.appName.length() > 0) {
            return media.appName + "正在播放" + media.title;
        }
        if (!foregroundValid && includeMedia && media.appName.length() > 0) {
            return media.appName + "正在播放";
        }
        if (!foregroundValid && includeMedia && media.title.length() > 0) {
            return "正在播放" + media.title;
        }
        String foregroundTitle = titleState.title();
        if (foregroundValid && foregroundTitle.length() > 0) {
            return "正在用" + appName + "看" + foregroundTitle;
        }
        if (foregroundValid) return "正在用" + appName;
        if ("idle".equals(packageName) || "idle".equals(appName)) return "暂时离开";
        return "";
    }

    private String taskDescriptionIfNeeded(ComponentName top, boolean idleCandidate) {
        if (idleCandidate || top == null) return null;
        String pkg = top.getPackageName();
        String nextKey = pkg + "/" + top.getClassName();
        boolean foregroundChanged = !nextKey.equals(lastForegroundKey);
        boolean browser = LspBrowserTitle.isBrowserPackage(pkg);
        return foregroundChanged || browser ? foregroundReader.focusedTaskDescription() : null;
    }

    private SnapshotDecision applyIdle(long now) {
        idleConsecutiveCount++;
        if (idleConsecutiveCount < IDLE_DEBOUNCE_COUNT) return new SnapshotDecision(false, false);
        if ("idle".equals(lastForegroundKey) && now - lastForegroundBroadcastAt < BROADCAST_DEBOUNCE_MS) {
            return new SnapshotDecision(false, false);
        }
        boolean forceDirectUpload = !"idle".equals(lastForegroundKey);
        lastForegroundKey = "idle";
        lastForegroundBroadcastAt = now;
        packageName = "idle";
        appName = "idle";
        activityName = "";
        titleState.apply("", "idle");
        return new SnapshotDecision(true, forceDirectUpload);
    }

    private boolean shouldSkipUnchangedForeground(ComponentName top, long now) {
        String key = top.getPackageName() + "/" + top.getClassName();
        return key.equals(lastForegroundKey) && now - lastForegroundBroadcastAt < BROADCAST_DEBOUNCE_MS;
    }

    private SnapshotDecision applyForeground(ComponentName top, String taskDescription, long now) {
        idleConsecutiveCount = 0;
        String nextPackageName = top.getPackageName();
        String nextActivityName = top.getClassName();
        String key = nextPackageName + "/" + nextActivityName;
        boolean changed = !key.equals(lastForegroundKey);
        if (changed) {
            host.logDebug("foreground: " + key + " title=" + (taskDescription != null ? taskDescription : ""));
        }
        if (shouldSkipUnchangedForeground(top, now)) return new SnapshotDecision(false, false);
        lastForegroundKey = key;
        lastForegroundBroadcastAt = now;
        packageName = nextPackageName;
        String label = host.resolveAppLabel(nextPackageName);
        appName = safeString(label);
        activityName = nextActivityName;
        if (LspBrowserTitle.isBrowserPackage(nextPackageName)) {
            titleState.markForegroundBrowser(nextPackageName, now);
        }
        applyTaskTitleIfNeeded(nextPackageName, label, taskDescription);
        return new SnapshotDecision(true, changed);
    }

    private void applyTaskTitleIfNeeded(String nextPackageName, String label, String taskDescription) {
        if (LspBrowserTitle.isBrowserPackage(nextPackageName)
                && taskDescription != null
                && taskDescription.length() > 0) {
            String browserTitle = LspBrowserTitle.cleanBrowserTitle(label, taskDescription);
            if (browserTitle != null) {
                if (titleState.shouldApplyBrowserCandidate(nextPackageName, packageName, browserTitle, "task")) {
                    titleState.apply(browserTitle, "task");
                }
            } else if (LspBrowserTitle.isGeneric(label, taskDescription)) {
                titleState.apply("", "task");
            }
        } else if (!LspBrowserTitle.isBrowserPackage(nextPackageName)) {
            titleState.apply("", "foreground");
        }
    }

    private Intent baseStatusIntent() {
        Intent intent = new Intent(ACTION_STATUS);
        intent.setComponent(new ComponentName(targetPackage, targetReceiver));
        return intent;
    }

    private void sendStatus(Intent intent) {
        Context context = host.systemContext();
        if (context == null) return;
        long token = Binder.clearCallingIdentity();
        try {
            context.sendBroadcast(intent, configPermission);
        } finally {
            Binder.restoreCallingIdentity(token);
        }
    }

    private String safeString(String value) {
        return value == null ? "" : value.trim();
    }
}
