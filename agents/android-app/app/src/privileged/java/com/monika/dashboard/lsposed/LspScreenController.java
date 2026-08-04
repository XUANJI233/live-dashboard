package com.monika.dashboard.lsposed;

import android.content.Context;
import android.os.PowerManager;
import android.os.SystemClock;

import java.lang.reflect.Method;

final class LspScreenController {
    interface Host {
        Context systemContext();
        void logDebug(String message);
    }

    private final Host host;
    private volatile Boolean supportedCache = null;

    LspScreenController(Host host) {
        this.host = host;
    }

    boolean supported() {
        PowerManager powerManager = powerManager();
        if (powerManager == null) return false;
        Boolean cached = supportedCache;
        if (cached != null) return cached;
        boolean supported = goToSleepMethod(powerManager, long.class, int.class, int.class) != null
                || goToSleepMethod(powerManager, long.class) != null;
        supportedCache = supported;
        return supported;
    }

    boolean screenOff() {
        PowerManager powerManager = powerManager();
        if (powerManager == null) return false;
        long now = SystemClock.uptimeMillis();
        if (invokeGoToSleep(powerManager, now, new Class<?>[]{long.class, int.class, int.class}, now, 0, 0)) {
            return true;
        }
        if (invokeGoToSleep(powerManager, now, new Class<?>[]{long.class}, now)) {
            return true;
        }
        host.logDebug("device command screen_off unsupported");
        return false;
    }

    private PowerManager powerManager() {
        try {
            Context ctx = host.systemContext();
            return ctx != null ? (PowerManager) ctx.getSystemService(Context.POWER_SERVICE) : null;
        } catch (Throwable t) {
            host.logDebug("screen controller power manager unavailable: " + t.getClass().getSimpleName());
            return null;
        }
    }

    private boolean invokeGoToSleep(PowerManager powerManager, long now, Class<?>[] parameterTypes, Object... args) {
        Method method = goToSleepMethod(powerManager, parameterTypes);
        if (method == null) return false;
        try {
            method.invoke(powerManager, args);
            supportedCache = true;
            return true;
        } catch (Throwable t) {
            host.logDebug("device command screen_off failed at " + now + ": " + t.getClass().getSimpleName());
            return false;
        }
    }

    private Method goToSleepMethod(PowerManager powerManager, Class<?>... parameterTypes) {
        try {
            Method method = powerManager.getClass().getMethod("goToSleep", parameterTypes);
            method.setAccessible(true);
            return method;
        } catch (Throwable ignored) {}
        try {
            Method method = powerManager.getClass().getDeclaredMethod("goToSleep", parameterTypes);
            method.setAccessible(true);
            return method;
        } catch (Throwable ignored) {}
        return null;
    }
}
