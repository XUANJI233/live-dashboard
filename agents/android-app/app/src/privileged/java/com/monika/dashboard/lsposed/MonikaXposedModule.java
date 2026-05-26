package com.monika.dashboard.lsposed;

import android.content.Intent;
import android.content.Context;
import android.content.ComponentName;
import android.media.MediaMetadata;
import android.media.session.PlaybackState;
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

    @Override
    public void onSystemServerStarting(@NonNull XposedModuleInterface.SystemServerStartingParam param) {
        ClassLoader cl = param.getClassLoader();
        installHooks(cl, "com.android.server.wm.ActivityTaskSupervisor",
                "resumeTopActivity", "setResumedActivity");
        installHooks(cl, "com.android.server.wm.RootWindowContainer",
                "resumeFocusedTasksTopActivities", "ensureActivitiesVisible");
        installHooks(cl, "com.android.server.wm.WindowManagerService",
                "updateFocusedWindow", "setFocusedApp");
        installHooks(cl, "com.android.server.media.MediaSessionService",
                "onSessionPlaystateChanged", "updateMediaButtonSession");
        installHooks(cl, "com.android.server.media.MediaSessionRecord",
                "setPlaybackState", "setMetadata", "updatePlaybackState", "updateMetadata");
    }

    private void installHooks(ClassLoader cl, String className, String... nameHints) {
        try {
            Class<?> clazz = Class.forName(className, false, cl);
            for (Method method : clazz.getDeclaredMethods()) {
                if (!matches(method.getName(), nameHints)) continue;
                hook(method)
                        .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                        .intercept(chain -> {
                            Object result = chain.proceed();
                            Object owner = chain.getThisObject();
                            if (owner != null && owner.getClass().getName().contains("MediaSession")) {
                                broadcastMediaSnapshot(owner);
                            } else {
                                broadcastSnapshot(owner);
                            }
                            return result;
                        });
                log(Log.INFO, TAG, "hooked " + className + "#" + method.getName());
            }
        } catch (Throwable t) {
            log(Log.WARN, TAG, "skip " + className + ": " + t.getClass().getSimpleName());
        }
    }

    private boolean matches(String name, String[] hints) {
        for (String hint : hints) {
            if (name.contains(hint)) return true;
        }
        return false;
    }

    private void broadcastSnapshot(Object owner) {
        try {
            Intent intent = new Intent(ACTION_STATUS);
            intent.setPackage(TARGET_PACKAGE);
            ComponentName top = getTopActivityComponentName();
            String packageName = top != null ? top.getPackageName() : findPackageName(owner);
            String activityName = top != null ? top.getClassName() : findActivityName(owner);
            if (packageName == null && activityName == null) return;
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
            Class<?> atm = Class.forName("android.app.ActivityTaskManager");
            Object service = atm.getDeclaredMethod("getService").invoke(null);
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

    private String findPackageName(Object owner) {
        String text = findInterestingObject(owner);
        if (text == null) return null;
        int slash = text.indexOf('/');
        if (slash <= 0) return null;
        String before = text.substring(0, slash);
        int space = before.lastIndexOf(' ');
        return (space >= 0 ? before.substring(space + 1) : before).trim();
    }

    private String findActivityName(Object owner) {
        String text = findInterestingObject(owner);
        if (text == null) return null;
        int slash = text.indexOf('/');
        if (slash < 0 || slash + 1 >= text.length()) return null;
        return text.substring(slash + 1).split("[ }]", 2)[0];
    }

    private String findInterestingObject(Object owner) {
        if (owner == null) return null;
        String direct = owner.toString();
        if (direct.contains("/")) return direct;
        for (Field field : owner.getClass().getDeclaredFields()) {
            String name = field.getName().toLowerCase();
            if (!name.contains("resumed") && !name.contains("focus") && !name.contains("top")) {
                continue;
            }
            try {
                field.setAccessible(true);
                Object value = field.get(owner);
                if (value != null && value.toString().contains("/")) return value.toString();
            } catch (Throwable ignored) {
            }
        }
        return null;
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
