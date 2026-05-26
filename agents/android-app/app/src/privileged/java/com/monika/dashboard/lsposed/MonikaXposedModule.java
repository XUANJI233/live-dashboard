package com.monika.dashboard.lsposed;

import android.content.Intent;
import android.content.Context;
import android.content.ComponentName;
import android.media.MediaMetadata;
import android.media.session.PlaybackState;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;

import com.monika.dashboard.BuildConfig;

import java.lang.reflect.Field;
import java.lang.reflect.Method;

import io.github.libxposed.api.XposedInterface;
import io.github.libxposed.api.XposedModule;
import io.github.libxposed.api.XposedModuleInterface;

public final class MonikaXposedModule extends XposedModule {
    private static final String TAG = "MonikaLSP";
    private static final String TARGET_PACKAGE = BuildConfig.APPLICATION_ID;
    private static final String ACTION_STATUS = "com.monika.dashboard.LSPOSED_STATUS";
    private static final long FOREGROUND_POLL_MS = 5000L;
    private static final long BROADCAST_DEBOUNCE_MS = 1500L;
    private volatile boolean samplerStarted = false;
    private volatile String lastForegroundKey = "";
    private volatile long lastForegroundBroadcastAt = 0L;
    private volatile long lastMediaBroadcastAt = 0L;

    @Override
    public void onSystemServerStarting(@NonNull XposedModuleInterface.SystemServerStartingParam param) {
        ClassLoader cl = param.getClassLoader();
        installForegroundSampler(cl);
        installMediaHooks(cl);
    }

    private void installForegroundSampler(ClassLoader cl) {
        try {
            Class<?> clazz = Class.forName("com.android.server.wm.ActivityTaskManagerService", false, cl);
            Method method = findMethod(clazz, "systemReady");
            if (method == null) {
                startForegroundSampler();
                return;
            }
            hook(method)
                    .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                    .intercept(chain -> {
                        Object result = chain.proceed();
                        startForegroundSampler();
                        return result;
                    });
            log(Log.INFO, TAG, "hooked ActivityTaskManagerService#systemReady");
        } catch (Throwable t) {
            log(Log.WARN, TAG, "foreground sampler hook skipped: " + t.getClass().getSimpleName());
            startForegroundSampler();
        }
    }

    private void startForegroundSampler() {
        if (samplerStarted) return;
        try {
            Handler handler = new Handler(Looper.getMainLooper());
            samplerStarted = true;
            handler.postDelayed(new Runnable() {
                @Override
                public void run() {
                    try {
                        broadcastSnapshot();
                    } catch (Throwable t) {
                        log(Log.WARN, TAG, "foreground sample failed: " + t.getClass().getSimpleName());
                    } finally {
                        handler.postDelayed(this, FOREGROUND_POLL_MS);
                    }
                }
            }, 15000L);
        } catch (Throwable t) {
            log(Log.WARN, TAG, "foreground sampler failed: " + t.getClass().getSimpleName());
        }
    }

    private void installMediaHooks(ClassLoader cl) {
        try {
            Class<?> clazz = Class.forName("com.android.server.media.MediaSessionRecord", false, cl);
            hookMediaMethod(clazz, "setPlaybackState");
            hookMediaMethod(clazz, "setMetadata");
        } catch (Throwable t) {
            log(Log.WARN, TAG, "media hooks skipped: " + t.getClass().getSimpleName());
        }
    }

    private void hookMediaMethod(Class<?> clazz, String name) {
        Method method = findMethod(clazz, name);
        if (method == null) return;
        try {
            hook(method)
                    .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                    .intercept(chain -> {
                        Object result = chain.proceed();
                        broadcastMediaSnapshot(chain.getThisObject());
                        return result;
                    });
            log(Log.INFO, TAG, "hooked MediaSessionRecord#" + name);
        } catch (Throwable t) {
            log(Log.WARN, TAG, "media hook failed " + name + ": " + t.getClass().getSimpleName());
        }
    }

    private Method findMethod(Class<?> clazz, String name) {
        for (Method method : clazz.getDeclaredMethods()) {
            if (name.equals(method.getName())) return method;
        }
        return null;
    }

    private void broadcastSnapshot() {
        try {
            ComponentName top = getTopActivityComponentName();
            if (top == null || isIgnoredPackage(top.getPackageName())) return;
            String packageName = top.getPackageName();
            String activityName = top.getClassName();
            String key = packageName + "/" + activityName;
            long now = System.currentTimeMillis();
            if (key.equals(lastForegroundKey) && now - lastForegroundBroadcastAt < BROADCAST_DEBOUNCE_MS) return;
            lastForegroundKey = key;
            lastForegroundBroadcastAt = now;

            Intent intent = new Intent(ACTION_STATUS);
            intent.setPackage(TARGET_PACKAGE);
            intent.putExtra("package_name", packageName);
            intent.putExtra("app_name", resolveAppLabel(packageName));
            intent.putExtra("activity", activityName);
            intent.putExtra("input_active", false);
            Context context = getSystemContext();
            if (context != null) context.sendBroadcast(intent);
        } catch (Throwable t) {
            log(Log.WARN, TAG, "broadcast failed: " + t.getClass().getSimpleName());
        }
    }

    private void broadcastMediaSnapshot(Object record) {
        try {
            long now = System.currentTimeMillis();
            if (now - lastMediaBroadcastAt < BROADCAST_DEBOUNCE_MS) return;
            lastMediaBroadcastAt = now;
            Context context = getSystemContext();
            if (context == null) return;
            Object playback = callAny(record, "getPlaybackState");
            if (playback == null) playback = readField(record, "mPlaybackState");
            Object metadata = callAny(record, "getMetadata");
            if (metadata == null) metadata = readField(record, "mMetadata");
            String packageName = stringValue(callAny(record, "getPackageName"));
            if (packageName == null) packageName = stringValue(readField(record, "mPackageName"));
            if (isIgnoredPackage(packageName)) return;

            Intent intent = new Intent(ACTION_STATUS);
            intent.setPackage(TARGET_PACKAGE);
            intent.putExtra("media_playing", isPlaying(playback));
            putIfNotNull(intent, "media_title", mediaText(metadata, MediaMetadata.METADATA_KEY_TITLE));
            putIfNotNull(intent, "media_artist", firstNonBlank(
                    mediaText(metadata, MediaMetadata.METADATA_KEY_ARTIST),
                    mediaText(metadata, MediaMetadata.METADATA_KEY_AUTHOR),
                    mediaText(metadata, MediaMetadata.METADATA_KEY_ALBUM_ARTIST)
            ));
            putIfNotNull(intent, "media_app", resolveAppLabel(packageName));
            putIfNotNull(intent, "media_state", playbackStateName(playback));
            context.sendBroadcast(intent);
        } catch (Throwable t) {
            log(Log.WARN, TAG, "media broadcast failed: " + t.getClass().getSimpleName());
        }
    }

    private ComponentName getTopActivityComponentName() {
        try {
            Object service = getActivityTaskManagerService();
            if (service == null) return null;
            Object info = callAny(service, "getFocusedRootTaskInfo");
            if (info == null) info = callAny(service, "getFocusedStackInfo");
            if (info == null) return null;
            Object top = readField(info, "topActivity");
            return top instanceof ComponentName ? (ComponentName) top : null;
        } catch (Throwable ignored) {
            return null;
        }
    }

    private Object getActivityTaskManagerService() {
        try {
            Class<?> atm = Class.forName("android.app.ActivityTaskManager");
            Object service = atm.getDeclaredMethod("getService").invoke(null);
            if (service != null) return service;
        } catch (Throwable ignored) {
        }
        try {
            Class<?> serviceManager = Class.forName("android.os.ServiceManager");
            Object binder = serviceManager.getDeclaredMethod("getService", String.class)
                    .invoke(null, "activity_task");
            if (binder == null) return null;
            Class<?> stub = Class.forName("android.app.IActivityTaskManager$Stub");
            return stub.getDeclaredMethod("asInterface", android.os.IBinder.class)
                    .invoke(null, binder);
        } catch (Throwable ignored) {
            return null;
        }
    }

    private Context getSystemContext() {
        try {
            Class<?> activityThread = Class.forName("android.app.ActivityThread");
            Method current = activityThread.getDeclaredMethod("currentActivityThread");
            Object thread = current.invoke(null);
            if (thread == null) return null;
            Method getSystemContext = activityThread.getDeclaredMethod("getSystemContext");
            return (Context) getSystemContext.invoke(thread);
        } catch (Throwable ignored) {
            return null;
        }
    }

    private Object callAny(Object target, String methodName) {
        if (target == null) return null;
        Class<?> clazz = target instanceof Class<?> ? (Class<?>) target : target.getClass();
        while (clazz != null) {
            try {
                Method method = clazz.getDeclaredMethod(methodName);
                method.setAccessible(true);
                return method.invoke(target instanceof Class<?> ? null : target);
            } catch (Throwable ignored) {
                clazz = clazz.getSuperclass();
            }
        }
        return null;
    }

    private Object readField(Object target, String fieldName) {
        if (target == null) return null;
        Class<?> clazz = target.getClass();
        while (clazz != null) {
            try {
                Field field = clazz.getDeclaredField(fieldName);
                field.setAccessible(true);
                return field.get(target);
            } catch (Throwable ignored) {
                clazz = clazz.getSuperclass();
            }
        }
        return null;
    }

    private String mediaText(Object metadata, String key) {
        if (!(metadata instanceof MediaMetadata)) return null;
        CharSequence value = ((MediaMetadata) metadata).getText(key);
        return value == null ? null : value.toString();
    }

    private boolean isPlaying(Object playback) {
        if (playback instanceof PlaybackState) {
            return ((PlaybackState) playback).getState() == PlaybackState.STATE_PLAYING;
        }
        return playback != null && playback.toString().contains("state=3");
    }

    private String playbackStateName(Object playback) {
        if (playback instanceof PlaybackState) {
            int state = ((PlaybackState) playback).getState();
            if (state == PlaybackState.STATE_PLAYING) return "playing";
            if (state == PlaybackState.STATE_PAUSED) return "paused";
            if (state == PlaybackState.STATE_STOPPED) return "stopped";
            return "state_" + state;
        }
        return playback == null ? null : playback.toString();
    }

    private String resolveAppLabel(String packageName) {
        if (packageName == null || packageName.length() == 0) return null;
        try {
            Context context = getSystemContext();
            if (context == null) return packageName;
            return context.getPackageManager()
                    .getApplicationLabel(context.getPackageManager().getApplicationInfo(packageName, 0))
                    .toString();
        } catch (Throwable ignored) {
            return packageName;
        }
    }

    private void putIfNotNull(Intent intent, String key, String value) {
        if (value != null && value.length() > 0 && !"null".equals(value)) {
            intent.putExtra(key, value);
        }
    }

    private String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && value.trim().length() > 0) return value;
        }
        return null;
    }

    private String stringValue(Object value) {
        return value == null ? null : value.toString();
    }

    private boolean isIgnoredPackage(String packageName) {
        return packageName == null ||
                "android".equals(packageName) ||
                "com.android.systemui".equals(packageName) ||
                "com.milink.service".equals(packageName);
    }
}
