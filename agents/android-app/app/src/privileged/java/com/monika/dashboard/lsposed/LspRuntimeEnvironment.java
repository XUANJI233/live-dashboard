package com.monika.dashboard.lsposed;

import android.content.Context;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.PowerManager;

import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.TimeZone;

final class LspRuntimeEnvironment {
    interface Host {
        void logInfo(String message);
        void logWarn(String message);
        void logDebug(String message);
    }

    private final LspHookSupport hookSupport;
    private final Host host;
    private volatile String processName = "";
    private volatile boolean systemServerProcess = false;
    private volatile Handler uploadHandler;
    private HandlerThread uploadThread;
    private volatile Context cachedSystemContext = null;

    LspRuntimeEnvironment(LspHookSupport hookSupport, Host host) {
        this.hookSupport = hookSupport;
        this.host = host;
    }

    void onModuleLoaded(String processName, boolean isSystemServer) {
        this.processName = safeString(processName);
        systemServerProcess = isSystemServer;
    }

    void markSystemServer() {
        systemServerProcess = true;
    }

    String processName() {
        return processName;
    }

    boolean systemServerProcess() {
        if (systemServerProcess) return true;
        String process = processName;
        return "system".equals(process)
                || "system_server".equals(process)
                || "android".equals(process);
    }

    void initUploadThread() {
        if (uploadThread != null && uploadHandler != null && uploadThread.isAlive()) return;
        try {
            uploadThread = new HandlerThread("MonikaLspUpload", android.os.Process.THREAD_PRIORITY_BACKGROUND);
            uploadThread.start();
            uploadHandler = new Handler(uploadThread.getLooper());
            host.logInfo("upload HandlerThread started");
        } catch (Throwable t) {
            host.logWarn("init upload thread failed: " + t.getClass().getSimpleName());
        }
    }

    Handler uploadHandler() {
        if (uploadHandler != null) return uploadHandler;
        synchronized (this) {
            if (uploadHandler == null) initUploadThread();
        }
        if (uploadHandler != null) return uploadHandler;
        return null;
    }

    Context systemContext() {
        Context cached = cachedSystemContext;
        if (cached != null) return cached;
        try {
            Class<?> activityThread = hookSupport.findClass("android.app.ActivityThread");
            Object thread = hookSupport.invokeNoArg(activityThread, "currentActivityThread");
            if (thread == null) return null;
            Context ctx = (Context) hookSupport.invokeNoArg(thread, "getSystemContext");
            if (ctx != null) cachedSystemContext = ctx;
            return ctx;
        } catch (Throwable ignored) {
            return null;
        }
    }

    String isoTime(long millis) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new java.util.Date(millis));
    }

    String localClock(long millis) {
        try {
            return new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new java.util.Date(millis));
        } catch (Throwable ignored) {
            return isoTime(millis);
        }
    }

    String resolveAppLabel(String packageName) {
        if (packageName == null || packageName.length() == 0) return null;
        try {
            Context context = systemContext();
            if (context == null) return packageName;
            return context.getPackageManager()
                    .getApplicationLabel(context.getPackageManager().getApplicationInfo(packageName, 0))
                    .toString();
        } catch (Throwable ignored) {
            return packageName;
        }
    }

    String resolveAppLabel(Context context, String packageName) {
        if (context == null || packageName == null || packageName.length() == 0) return packageName;
        try {
            return context.getPackageManager()
                    .getApplicationLabel(context.getPackageManager().getApplicationInfo(packageName, 0))
                    .toString();
        } catch (Throwable ignored) {
            return packageName;
        }
    }

    boolean screenInteractive() {
        try {
            Context ctx = systemContext();
            if (ctx == null) return true;
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm == null) return true;
            return pm.isInteractive();
        } catch (Throwable t) {
            return true;
        }
    }

    boolean ignoredPackage(String packageName) {
        return packageName == null ||
                "android".equals(packageName) ||
                "com.android.systemui".equals(packageName) ||
                "com.milink.service".equals(packageName) ||
                "com.miui.home".equals(packageName) ||
                "com.android.launcher".equals(packageName) ||
                "com.android.launcher2".equals(packageName) ||
                "com.android.launcher3".equals(packageName) ||
                "com.google.android.apps.nexuslauncher".equals(packageName) ||
                "com.sec.android.app.launcher".equals(packageName) ||
                "com.huawei.android.launcher".equals(packageName) ||
                "com.oppo.launcher".equals(packageName) ||
                "com.bbk.launcher2".equals(packageName) ||
                "net.oneplus.launcher".equals(packageName);
    }

    private static String safeString(String value) {
        return value == null ? "" : value.trim();
    }
}
