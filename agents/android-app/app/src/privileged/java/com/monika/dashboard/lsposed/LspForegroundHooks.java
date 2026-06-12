package com.monika.dashboard.lsposed;

import android.os.Bundle;

import java.lang.reflect.Method;
import java.util.List;

final class LspForegroundHooks {
    interface Host {
        void startForegroundSampler();
        void scheduleForegroundSnapshot(long delayMs);
        void logInfo(String message);
        void logWarn(String message);
        void logDebug(String message);
    }

    private final LspHookSupport hookSupport;
    private final Host host;

    LspForegroundHooks(LspHookSupport hookSupport, Host host) {
        this.hookSupport = hookSupport;
        this.host = host;
    }

    void install(ClassLoader cl) {
        try {
            Class<?> clazz = hookSupport.findClass("com.android.server.wm.ActivityTaskManagerService", cl);
            if (clazz == null) throw new ClassNotFoundException("ActivityTaskManagerService");

            // AOSP uses onSystemReady on modern releases; keep systemReady as
            // a legacy/OEM fallback.
            Method readyMethod = hookSupport.declaredMethodByName(clazz, "onSystemReady");
            if (readyMethod == null) readyMethod = hookSupport.declaredMethodByName(clazz, "systemReady");
            if (readyMethod != null) {
                boolean hooked = hookSupport.hookAfter(readyMethod, chain -> host.startForegroundSampler());
                if (hooked) {
                    host.logInfo("hooked ActivityTaskManagerService#" + readyMethod.getName());
                } else {
                    host.startForegroundSampler();
                }
            } else {
                host.startForegroundSampler();
            }

            Method moveToFront = moveTaskToFrontMethod(clazz);
            if (moveToFront != null) {
                boolean hooked = hookSupport.hookAfter(
                        moveToFront,
                        chain -> host.scheduleForegroundSnapshot(300L));
                if (hooked) {
                    host.logInfo("hooked ActivityTaskManagerService#moveTaskToFront (event-driven)");
                }
            }
            int foregroundHooks = installForegroundResumeEventHooks(cl);
            if (foregroundHooks > 0) {
                host.logInfo("hooked foreground resume event methods: " + foregroundHooks);
            }
        } catch (Throwable t) {
            host.logWarn("foreground sampler hook skipped: " + t.getClass().getSimpleName());
            host.startForegroundSampler();
        }
    }

    private Method moveTaskToFrontMethod(Class<?> clazz) {
        Method moveToFront = null;
        try {
            Class<?> iAppThread = hookSupport.findClass("android.app.IApplicationThread");
            if (iAppThread == null) throw new ClassNotFoundException("IApplicationThread");
            moveToFront = hookSupport.declaredMethod(
                    clazz,
                    "moveTaskToFront",
                    iAppThread,
                    String.class,
                    int.class,
                    int.class,
                    Bundle.class);
            if (moveToFront == null) {
                moveToFront = hookSupport.declaredMethod(
                        clazz,
                        "moveTaskToFront",
                        iAppThread,
                        String.class,
                        int.class,
                        Bundle.class);
            }
        } catch (ClassNotFoundException ignored) {}
        if (moveToFront == null) {
            List<Method> methods = hookSupport.declaredMethodsByName(clazz, "moveTaskToFront");
            if (!methods.isEmpty()) moveToFront = methods.get(0);
        }
        return moveToFront;
    }

    private int installForegroundResumeEventHooks(ClassLoader cl) {
        int hooked = 0;
        hooked += hookForegroundEventMethods(cl,
                "com.android.server.wm.ActivityTaskManagerService",
                600L,
                "startActivityAsUser",
                "setFocusedTask");
        hooked += hookForegroundEventMethods(cl,
                "com.android.server.wm.RootWindowContainer",
                300L,
                "resumeFocusedTasksTopActivities");
        hooked += hookForegroundEventMethods(cl,
                "com.android.server.wm.Task",
                300L,
                "resumeTopActivityUncheckedLocked");
        return hooked;
    }

    private int hookForegroundEventMethods(ClassLoader cl, String className, long delayMs, String... methodNames) {
        try {
            Class<?> clazz = hookSupport.findClass(className, cl);
            if (clazz == null) return 0;
            int hooked = 0;
            for (Method method : hookSupport.declaredMethodsByName(clazz, methodNames)) {
                boolean ok = hookSupport.hookAfterResult(method, (chain, result) -> {
                    if (foregroundEventLikelyChanged(result)) {
                        host.scheduleForegroundSnapshot(delayMs);
                    }
                });
                if (ok) hooked++;
            }
            return hooked;
        } catch (Throwable t) {
            host.logDebug("foreground event hook skipped for " + className + ": " + t.getClass().getSimpleName());
            return 0;
        }
    }

    private boolean foregroundEventLikelyChanged(Object result) {
        if (result instanceof Boolean) return (Boolean) result;
        if (result instanceof Integer) return ((Integer) result) >= 0;
        return true;
    }
}
