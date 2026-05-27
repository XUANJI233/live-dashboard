package com.monika.dashboard.lsposed;

import android.app.Activity;
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
import java.util.List;

import io.github.libxposed.api.XposedInterface;
import io.github.libxposed.api.XposedModule;
import io.github.libxposed.api.XposedModuleInterface;

public final class MonikaXposedModule extends XposedModule {
    private static final String TAG = "MonikaLSP";
    private static final String TARGET_PACKAGE = BuildConfig.APPLICATION_ID;
    private static final String ACTION_STATUS = "com.monika.dashboard.LSPOSED_STATUS";
    private static final long FOREGROUND_POLL_MS = 5000L;
    private static final long BROADCAST_DEBOUNCE_MS = 1500L;
    private static final String[] BROWSER_PACKAGES = new String[] {
            "com.android.browser",
            "com.android.chrome",
            "com.chrome.beta",
            "com.chrome.dev",
            "com.chrome.canary",
            "org.chromium.chrome",
            "org.chromium.webview_shell",
            "org.mozilla.firefox",
            "org.mozilla.firefox_beta",
            "org.mozilla.fenix",
            "org.mozilla.fennec_aurora",
            "org.mozilla.focus",
            "org.mozilla.klar",
            "org.mozilla.reference.browser",
            "org.torproject.torbrowser",
            "io.github.forkmaintainers.iceraven",
            "com.microsoft.emmx",
            "com.microsoft.emmx.beta",
            "com.microsoft.emmx.dev",
            "com.microsoft.emmx.canary",
            "com.brave.browser",
            "com.brave.browser_beta",
            "com.brave.browser_nightly",
            "com.vivaldi.browser",
            "com.vivaldi.browser.snapshot",
            "com.opera.browser",
            "com.opera.browser.beta",
            "com.opera.mini.native",
            "com.duckduckgo.mobile.android",
            "com.kiwibrowser.browser",
            "mark.via.gp",
            "com.UCMobile.intl",
            "com.sec.android.app.sbrowser",
            "com.sec.android.app.sbrowser.beta",
            "com.yandex.browser",
            "com.yandex.browser.beta",
            "com.qwant.liberty",
            "com.ecosia.android",
            "com.arc.browser",
            "app.vanadium.browser",
            "us.spotco.fennec_dos",
            "com.cromite"
    };
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

    @Override
    public void onPackageReady(@NonNull XposedModuleInterface.PackageReadyParam param) {
        String packageName = param.getPackageName();
        if (!isBrowserPackage(packageName)) return;
        installActivityTitleHooks(param.getClassLoader(), packageName);
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
        try {
            Class<?> service = Class.forName("com.android.server.media.MediaSessionService", false, cl);
            hookMediaServiceMethod(service, "onSessionPlaystateChanged");
            hookMediaServiceMethod(service, "onSessionPlaybackStateChanged");
            hookMediaServiceMethod(service, "onSessionMetadataChanged");
            hookMediaServiceMethod(service, "updateMediaButtonSession");
        } catch (Throwable t) {
            log(Log.WARN, TAG, "media service hooks skipped: " + t.getClass().getSimpleName());
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

    private void installActivityTitleHooks(ClassLoader cl, String packageName) {
        try {
            Class<?> activity = Class.forName("android.app.Activity", false, cl);
            Method setTitleText = activity.getDeclaredMethod("setTitle", CharSequence.class);
            hook(setTitleText)
                    .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                    .intercept(chain -> {
                        Object result = chain.proceed();
                        Object owner = chain.getThisObject();
                        List<Object> args = chain.getArgs();
                        CharSequence title = args.size() > 0 && args.get(0) instanceof CharSequence
                                ? (CharSequence) args.get(0)
                                : owner instanceof Activity ? ((Activity) owner).getTitle() : null;
                        if (owner instanceof Activity && title != null) {
                            broadcastActivityTitle((Activity) owner, packageName, title.toString());
                        }
                        return result;
                    });
            Method setTitleRes = activity.getDeclaredMethod("setTitle", int.class);
            hook(setTitleRes)
                    .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                    .intercept(chain -> {
                        Object result = chain.proceed();
                        Object owner = chain.getThisObject();
                        if (owner instanceof Activity) {
                            CharSequence title = ((Activity) owner).getTitle();
                            if (title != null) broadcastActivityTitle((Activity) owner, packageName, title.toString());
                        }
                        return result;
                    });
            log(Log.INFO, TAG, "hooked Activity#setTitle for " + packageName);
        } catch (Throwable t) {
            log(Log.WARN, TAG, "activity title hook failed for " + packageName + ": " + t.getClass().getSimpleName());
        }
    }

    private void hookMediaServiceMethod(Class<?> clazz, String name) {
        for (Method method : clazz.getDeclaredMethods()) {
            if (!name.equals(method.getName())) continue;
            try {
                hook(method)
                        .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                        .intercept(chain -> {
                            Object result = chain.proceed();
                            Object record = findMediaSessionRecord(chain.getThisObject(), chain.getArgs());
                            if (record != null) broadcastMediaSnapshot(record);
                            return result;
                        });
                log(Log.INFO, TAG, "hooked MediaSessionService#" + name);
            } catch (Throwable t) {
                log(Log.WARN, TAG, "media service hook failed " + name + ": " + t.getClass().getSimpleName());
            }
        }
    }

    private Object findMediaSessionRecord(Object owner, List<Object> args) {
        if (args != null) {
            for (Object arg : args) {
                if (arg != null && arg.getClass().getName().contains("MediaSessionRecord")) return arg;
            }
        }
        if (owner != null && owner.getClass().getName().contains("MediaSessionRecord")) return owner;
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
            putIfNotNull(intent, "media_package", packageName);
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

    private void broadcastActivityTitle(Activity activity, String packageName, String title) {
        try {
            String cleanTitle = cleanTitle(title);
            if (cleanTitle == null || isIgnoredPackage(packageName)) return;
            Intent intent = new Intent(ACTION_STATUS);
            intent.setPackage(TARGET_PACKAGE);
            intent.putExtra("package_name", packageName);
            intent.putExtra("app_name", resolveAppLabel(activity, packageName));
            intent.putExtra("activity", activity.getClass().getName());
            intent.putExtra("title", cleanTitle);
            activity.sendBroadcast(intent);
        } catch (Throwable t) {
            log(Log.WARN, TAG, "activity title broadcast failed: " + t.getClass().getSimpleName());
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

    private String resolveAppLabel(Context context, String packageName) {
        if (context == null || packageName == null || packageName.length() == 0) return packageName;
        try {
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

    private boolean isBrowserPackage(String packageName) {
        if (packageName == null) return false;
        for (String browser : BROWSER_PACKAGES) {
            if (browser.equals(packageName)) return true;
        }
        return false;
    }

    private String cleanTitle(String title) {
        if (title == null) return null;
        String cleaned = title.replace('\n', ' ').replace('\r', ' ').trim();
        if (cleaned.length() == 0 || "null".equals(cleaned)) return null;
        if (cleaned.length() > 256) return cleaned.substring(0, 256);
        return cleaned;
    }
}
