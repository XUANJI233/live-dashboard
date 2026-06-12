package com.monika.dashboard.lsposed;

import android.content.Context;
import android.content.Intent;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.provider.Settings;

import org.json.JSONObject;

final class LspSupervisionCoordinator {
    interface Host {
        Context systemContext();
        Handler uploadHandler();
        boolean enabled();
        boolean uploadForeground();
        boolean systemServerProcess();
        boolean networkConnected();
        String foregroundPackage();
        String foregroundApp();
        String primaryDisplayTitle();
        boolean protectedPackage(String packageName);
        LspFreezeResult freezePackage(String packageName, String reason, long now, long until);
        boolean clearFreeze(String reason);
        void requestDirectUpload(boolean force);
        void logDebug(String message);
    }

    private static final int DAILY_UNFREEZE_HOUR = 3;

    private final LspSupervisionPolicy policy = new LspSupervisionPolicy();
    private final Host host;
    private volatile long policyCheckDueAt = 0L;
    private volatile boolean dailyFreezeCleanupScheduled = false;

    LspSupervisionCoordinator(Host host) {
        this.host = host;
    }

    boolean shouldRequestReviewForReport() {
        return policy.shouldRequestReviewForReport();
    }

    boolean applyPolicy(JSONObject payload) {
        boolean applied = policy.applyPolicy(payload);
        if (applied) evaluate(System.currentTimeMillis());
        return applied;
    }

    void finishPendingReview() {
        policy.finishPendingReview();
    }

    void markReviewSentIfRequested(String body) {
        try {
            JSONObject json = new JSONObject(body);
            JSONObject extra = json.optJSONObject("extra");
            JSONObject device = extra != null ? extra.optJSONObject("device") : null;
            if (device != null && strictBoolean(device, "supervision_check_requested", false)) {
                policy.markReviewRequestSent();
            }
        } catch (Throwable ignored) {}
    }

    void evaluate(long now) {
        try {
            if (!host.enabled() || !host.uploadForeground() || !host.systemServerProcess()) return;
            String pkg = safeString(host.foregroundPackage());
            boolean protectedPackage = pkg.length() == 0 || host.protectedPackage(pkg);
            LspSupervisionPolicy.Decision decision = policy.evaluate(
                    pkg,
                    safeString(host.foregroundApp()),
                    host.primaryDisplayTitle(),
                    now,
                    protectedPackage);
            if (decision.timeLimitFreezePackage.length() > 0) {
                host.freezePackage(
                        decision.timeLimitFreezePackage,
                        decision.timeLimitReason,
                        now,
                        nextDailyUnfreezeAt(now));
                host.requestDirectUpload(true);
            }
            if (decision.riskReviewPackage.length() > 0) {
                host.freezePackage(
                        decision.riskReviewPackage,
                        decision.riskReviewReason,
                        now,
                        nextDailyUnfreezeAt(now));
                openNetworkSettingsIfOffline();
                host.requestDirectUpload(true);
            }
            scheduleCheck(decision.nextCheckDelayMs);
        } catch (Throwable t) {
            host.logDebug("supervision policy evaluate skipped: " + t.getClass().getSimpleName());
        }
    }

    void scheduleDailyCleanup(Handler handler) {
        if (handler == null || dailyFreezeCleanupScheduled || !host.systemServerProcess()) return;
        dailyFreezeCleanupScheduled = true;
        long now = System.currentTimeMillis();
        long delay = Math.max(1000L, nextDailyUnfreezeAt(now) - now);
        handler.postDelayed(() -> {
            dailyFreezeCleanupScheduled = false;
            clearFreeze("daily reset");
            scheduleDailyCleanup(handler);
        }, delay);
    }

    void clearFreeze(String reason) {
        if (host.clearFreeze(reason)) {
            host.requestDirectUpload(true);
        }
    }

    long nextDailyUnfreezeAt(long now) {
        java.util.Calendar calendar = java.util.Calendar.getInstance();
        calendar.setTimeInMillis(now);
        calendar.set(java.util.Calendar.HOUR_OF_DAY, DAILY_UNFREEZE_HOUR);
        calendar.set(java.util.Calendar.MINUTE, 0);
        calendar.set(java.util.Calendar.SECOND, 0);
        calendar.set(java.util.Calendar.MILLISECOND, 0);
        if (calendar.getTimeInMillis() <= now) {
            calendar.add(java.util.Calendar.DAY_OF_YEAR, 1);
        }
        return calendar.getTimeInMillis();
    }

    private void scheduleCheck(long delayMs) {
        if (delayMs <= 0L || !host.systemServerProcess()) return;
        Handler handler = host.uploadHandler();
        if (handler == null) return;
        long dueAt = System.currentTimeMillis() + delayMs;
        long currentDue = policyCheckDueAt;
        if (currentDue > 0L && currentDue <= dueAt) return;
        policyCheckDueAt = dueAt;
        handler.postDelayed(() -> {
            long scheduledDue = policyCheckDueAt;
            if (scheduledDue > 0L && System.currentTimeMillis() + 500L < scheduledDue) return;
            policyCheckDueAt = 0L;
            evaluate(System.currentTimeMillis());
        }, delayMs);
    }

    private void openNetworkSettingsIfOffline() {
        try {
            if (host.networkConnected()) return;
            Context ctx = host.systemContext();
            if (ctx == null) return;
            Intent intent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? new Intent(Settings.Panel.ACTION_INTERNET_CONNECTIVITY)
                    : new Intent(Settings.ACTION_WIRELESS_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            long token = Binder.clearCallingIdentity();
            try {
                ctx.startActivity(intent);
            } finally {
                Binder.restoreCallingIdentity(token);
            }
        } catch (Throwable t) {
            host.logDebug("open network settings skipped: " + t.getClass().getSimpleName());
        }
    }

    private boolean strictBoolean(JSONObject object, String key, boolean defaultWhenMissing) {
        if (object == null || !object.has(key) || object.isNull(key)) return defaultWhenMissing;
        Object value = object.opt(key);
        return value instanceof Boolean && ((Boolean) value).booleanValue();
    }

    private String safeString(String value) {
        return value == null ? "" : value.trim();
    }
}
