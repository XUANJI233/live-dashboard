package com.monika.dashboard.lsposed;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;

final class LspDeviceFeedback {
    interface Host {
        Context systemContext();
        String localClock(long millis);
        void logDebug(String message);
    }

    private final LspNotificationCenter notificationCenter;
    private final Host host;

    LspDeviceFeedback(LspNotificationCenter notificationCenter, Host host) {
        this.notificationCenter = notificationCenter;
        this.host = host;
    }

    void postSupervisionFreeze(String packageName, String appName, String reason, long until) {
        try {
            Context ctx = host.systemContext();
            if (ctx == null) return;
            notificationCenter.postSupervisionFreeze(ctx, packageName, appName, reason, host.localClock(until));
        } catch (Throwable t) {
            host.logDebug("supervision freeze notification skipped: " + t.getClass().getSimpleName());
        }
    }

    boolean postDeviceCommandSay(String commandId, String text) {
        try {
            Context ctx = host.systemContext();
            if (ctx == null) return false;
            return notificationCenter.postDeviceCommandSay(ctx, commandId, text);
        } catch (Throwable t) {
            host.logDebug("device command say notification skipped: " + t.getClass().getSimpleName());
            return false;
        }
    }

    @SuppressLint("MissingPermission")
    boolean vibrate(long durationMs) {
        try {
            Context ctx = host.systemContext();
            if (ctx == null) return false;
            Vibrator vibrator;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                VibratorManager manager = (VibratorManager) ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                vibrator = manager != null ? manager.getDefaultVibrator() : null;
            } else {
                vibrator = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
            }
            if (vibrator == null || !vibrator.hasVibrator()) return false;
            long safeDuration = Math.max(100L, Math.min(2000L, durationMs));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createOneShot(safeDuration, VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                vibrator.vibrate(safeDuration);
            }
            return true;
        } catch (Throwable t) {
            host.logDebug("device command vibrate failed: " + t.getClass().getSimpleName());
            return false;
        }
    }

    void cancelSupervisionFreeze(String packageName) {
        try {
            Context ctx = host.systemContext();
            if (ctx == null) return;
            notificationCenter.cancelSupervisionFreeze(ctx, packageName);
        } catch (Throwable t) {
            host.logDebug("cancel supervision freeze notification skipped: " + t.getClass().getSimpleName());
        }
    }
}
