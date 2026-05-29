package com.monika.dashboard.lsposed;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Intent;
import android.content.Context;
import android.content.ComponentName;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.os.Binder;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;

import com.monika.dashboard.BuildConfig;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.text.SimpleDateFormat;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.IOException;

import io.github.libxposed.api.XposedInterface;
import io.github.libxposed.api.XposedModule;
import io.github.libxposed.api.XposedModuleInterface;
import org.json.JSONObject;

public final class MonikaXposedModule extends XposedModule {
    private static final String TAG = "MonikaLSP";
    private static final String TARGET_PACKAGE = BuildConfig.APPLICATION_ID;
    private static final String TARGET_RECEIVER = TARGET_PACKAGE + ".system.LsposedBridgeReceiver";
    private static final String ACTION_STATUS = "com.monika.dashboard.LSPOSED_STATUS";
    private static final String ACTION_CONFIG = "com.monika.dashboard.LSPOSED_CONFIG";
    private static final String ACTION_BROWSER_TITLE = "com.monika.dashboard.LSPOSED_BROWSER_TITLE";
    private static final String CONFIG_PERMISSION = "com.monika.dashboard.permission.LSPOSED_CONFIG";
    private static final long FOREGROUND_POLL_MS = 5000L;
    private static final long BROADCAST_DEBOUNCE_MS = 1500L;
    private static final long MIN_DIRECT_UPLOAD_MS = 5000L;
    private static final long IDLE_DEBOUNCE_COUNT = 12; // 12 consecutive idle samples (~60s at 5s poll) before uploading
    private static final long WS_RETRY_BASE_MS = 30_000L;  // first retry delay
    private static final long WS_RETRY_MAX_MS = 300_000L;  // max retry delay (5 min)
    
    // Static instance for global access
    private static MonikaXposedModule instance;
    
    private volatile int idleConsecutiveCount = 0;
    private volatile long wsLastFailAt = 0L;
    private volatile long wsRetryDelayMs = WS_RETRY_BASE_MS;
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
    private volatile boolean mediaListenerRegistered = false;
    private MediaSessionManager mediaSessionManager;
    private volatile String currentProcessName = "";
    private volatile boolean browserTitleReceiverRegistered = false;
    private volatile Handler uploadHandler;
    private HandlerThread uploadThread;
    private volatile String lastForegroundKey = "";
    private volatile long lastForegroundBroadcastAt = 0L;
    private volatile boolean configReceiverRegistered = false;
    private volatile boolean directUploadEnabled = false;
    private volatile String directServerUrl = "";
    private volatile String directToken = "";
    private volatile long directIntervalMs = 30000L;
    private volatile boolean directUploadForeground = true;
    private volatile boolean directUploadMedia = true;
    private volatile long lastDirectUploadAt = 0L;
    private volatile LspWebSocketClient wsClient = null;
    private volatile String foregroundPackage = "";
    private volatile String foregroundApp = "";
    private volatile String foregroundActivity = "";
    private volatile String foregroundTitle = "";
    private volatile boolean mediaPlaying = false;
    private volatile String mediaPackage = "";
    private volatile String mediaApp = "";
    private volatile String mediaTitle = "";
    private volatile String mediaArtist = "";
    private volatile String mediaState = "";

    @Override
    public void onModuleLoaded(@NonNull XposedModuleInterface.ModuleLoadedParam param) {
        instance = this;
        currentProcessName = param.getProcessName();
        log(Log.INFO, TAG, "onModuleLoaded: isSystemServer=" + param.isSystemServer() 
                + " process=" + param.getProcessName() 
                + " apiVersion=" + getApiVersion() 
                + " framework=" + getFrameworkName() + " v" + getFrameworkVersion());
    }

    @Override
    public void onSystemServerStarting(@NonNull XposedModuleInterface.SystemServerStartingParam param) {
        ClassLoader cl = param.getClassLoader();
        initUploadThread();
        installForegroundSampler(cl);
    }

    @Override
    public void onPackageReady(@NonNull XposedModuleInterface.PackageReadyParam param) {
        String packageName = param.getPackageName();
        if (!isBrowserPackage(packageName)) return;
        // Only hook browser main process — skip renderer, sandbox, GPU, service processes
        // PackageReadyParam doesn't have getProcessName(); use stored process name from onModuleLoaded
        String processName = currentProcessName;
        if (processName != null && !processName.isEmpty() && !packageName.equals(processName)) {
            log(Log.DEBUG, TAG, "skip browser non-main process: " + packageName + "/" + processName);
            return;
        }
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
            // Deoptimize to prevent ART from inlining systemReady into its callers,
            // which would bypass our hook (per libxposed best practice).
            try { deoptimize(method); } catch (Throwable t) { log(Log.WARN, TAG, "deoptimize systemReady failed: " + t.getClass().getSimpleName()); }
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
            // Defer config loading and receiver registration to allow system context to fully initialize
            handler.postDelayed(() -> {
                try { loadDirectUploadConfig(); } catch (Throwable t) { log(Log.WARN, TAG, "deferred load config failed: " + t.getClass().getSimpleName()); }
                try { registerConfigReceiver(handler); } catch (Throwable t) { log(Log.WARN, TAG, "deferred register receiver failed: " + t.getClass().getSimpleName()); }
                try { registerBrowserTitleReceiver(handler); } catch (Throwable t) { log(Log.WARN, TAG, "deferred register browser title receiver failed: " + t.getClass().getSimpleName()); }
                try { initMediaSessionListener(); } catch (Throwable t) { log(Log.WARN, TAG, "deferred init media listener failed: " + t.getClass().getSimpleName()); }
            }, 10000L);
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

    private void registerConfigReceiver(Handler handler) {
        if (configReceiverRegistered) return;
        Context context = getSystemContext();
        if (context == null) return;
        try {
            IntentFilter filter = new IntentFilter(ACTION_CONFIG);
            BroadcastReceiver configReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context receiverContext, Intent intent) {
                    if (!ACTION_CONFIG.equals(intent.getAction())) return;
                    saveDirectUploadConfig(receiverContext, intent);
                }
            };
            // 5-param registerReceiver(..., flags) requires API 34.
            // On API 34+: use 5-param with RECEIVER_EXPORTED + handler + permission.
            // On API < 34: fall back to 4-param with permission + handler (no explicit export flag).
            if (android.os.Build.VERSION.SDK_INT >= 34) {
                context.registerReceiver(configReceiver, filter, CONFIG_PERMISSION, handler, Context.RECEIVER_EXPORTED);
            } else {
                context.registerReceiver(configReceiver, filter, CONFIG_PERMISSION, handler);
            }
            configReceiverRegistered = true;
            log(Log.INFO, TAG, "registered direct upload config receiver");
        } catch (Throwable t) {
            log(Log.WARN, TAG, "config receiver failed: " + t.getClass().getSimpleName());
        }
    }

    private void initUploadThread() {
        try {
            uploadThread = new HandlerThread("MonikaLspUpload", android.os.Process.THREAD_PRIORITY_BACKGROUND);
            uploadThread.start();
            uploadHandler = new Handler(uploadThread.getLooper());
            log(Log.INFO, TAG, "upload HandlerThread started");
        } catch (Throwable t) {
            log(Log.WARN, TAG, "init upload thread failed: " + t.getClass().getSimpleName());
        }
    }

    private Handler getUploadHandler() {
        if (uploadHandler != null) return uploadHandler;
        return new Handler(Looper.getMainLooper());
    }

    private void registerBrowserTitleReceiver(Handler handler) {
        if (browserTitleReceiverRegistered) return;
        Context context = getSystemContext();
        if (context == null) return;
        try {
            IntentFilter filter = new IntentFilter(ACTION_BROWSER_TITLE);
            BroadcastReceiver receiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context ctx, Intent intent) {
                    if (!ACTION_BROWSER_TITLE.equals(intent.getAction())) return;
                    String pkg = intent.getStringExtra("package_name");
                    String title = intent.getStringExtra("title");
                    String activity = intent.getStringExtra("activity");
                    if (!isBrowserPackage(pkg)) return;
                    if (title == null || title.trim().isEmpty()) return;

                    // Security: verify sender identity on API 34+
                    // Note: getSentFromPackage() requires sender to use setShareIdentityEnabled(true),
                    // which requires sendBroadcast(Intent, String, Bundle) — a non-public API.
                    // So we rely on the foreground package check below as the primary security measure.
                    if (android.os.Build.VERSION.SDK_INT >= 34) {
                        try {
                            String sentPkg = getSentFromPackage();
                            if (sentPkg != null && !sentPkg.equals(pkg)) {
                                log(Log.WARN, TAG, "browser title rejected: sender=" + sentPkg + " claimed=" + pkg);
                                return;
                            }
                        } catch (Throwable ignored) {}
                    }

                    // Security: verify the claimed package is actually the current foreground
                    ComponentName top = getTopActivityComponentName();
                    if (top == null || !pkg.equals(top.getPackageName())) {
                        log(Log.DEBUG, TAG, "browser title ignored: " + pkg + " is not foreground (top=" +
                                (top != null ? top.getPackageName() : "null") + ")");
                        return;
                    }

                    foregroundPackage = pkg;
                    foregroundApp = safeString(resolveAppLabel(pkg));
                    foregroundActivity = safeString(activity);
                    foregroundTitle = cleanTitle(title);
                    log(Log.DEBUG, TAG, "browser title received: " + pkg + " title=" + foregroundTitle);
                    maybeDirectUpload(true);
                }
            };
            // 5-param registerReceiver(..., flags) requires API 34.
            // On API 34+: use 5-param with RECEIVER_EXPORTED + handler.
            // On API 33: use 3-param with RECEIVER_EXPORTED (loses handler).
            // On API < 33: use 4-param with handler (no explicit export flag).
            if (android.os.Build.VERSION.SDK_INT >= 34) {
                context.registerReceiver(receiver, filter, null, handler, Context.RECEIVER_EXPORTED);
            } else if (android.os.Build.VERSION.SDK_INT >= 33) {
                context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
            } else {
                context.registerReceiver(receiver, filter, null, handler);
            }
            browserTitleReceiverRegistered = true;
            log(Log.INFO, TAG, "registered browser title receiver");
        } catch (Throwable t) {
            log(Log.WARN, TAG, "browser title receiver failed: " + t.getClass().getSimpleName());
        }
    }

    /**
     * Initialize MediaSessionManager listener for media capture.
     * Uses standard Android API (MediaSessionManager.getActiveSessions + MediaController.Callback)
     * instead of hooking internal MediaSessionRecord methods which may not exist on MIUI/HyperOS.
     * Reference: SuperLyric (PlayStateListener), HyperLyric (MediaMetadataHelper)
     */
    private void initMediaSessionListener() {
        if (mediaListenerRegistered) return;
        Context context = getSystemContext();
        if (context == null) return;
        try {
            mediaSessionManager = (MediaSessionManager) context.getSystemService(Context.MEDIA_SESSION_SERVICE);
            if (mediaSessionManager == null) {
                log(Log.WARN, TAG, "MediaSessionManager not available");
                return;
            }
            mediaSessionManager.addOnActiveSessionsChangedListener(
                    controllers -> {
                        try {
                            if (controllers == null) return;
                            log(Log.DEBUG, TAG, "active sessions changed: " + controllers.size());
                            // Check if the currently tracked media package is still active
                            String trackedPkg = mediaPackage;
                            if (trackedPkg.length() > 0) {
                                boolean stillActive = false;
                                for (MediaController c : controllers) {
                                    if (trackedPkg.equals(c.getPackageName())) {
                                        stillActive = true;
                                        break;
                                    }
                                }
                                if (!stillActive) {
                                    log(Log.DEBUG, TAG, "media session removed: " + trackedPkg + ", clearing media info");
                                    mediaPlaying = false;
                                    mediaTitle = "";
                                    mediaArtist = "";
                                    mediaPackage = "";
                                    mediaApp = "";
                                    mediaState = "";
                                }
                            }
                            for (MediaController controller : controllers) {
                                registerMediaControllerCallback(controller);
                            }
                            maybeDirectUpload(false);
                        } catch (Throwable t) {
                            log(Log.WARN, TAG, "onActiveSessionsChanged failed: " + t.getClass().getSimpleName());
                        }
                    }, null);
            List<MediaController> active = mediaSessionManager.getActiveSessions(null);
            if (active != null) {
                log(Log.INFO, TAG, "initial active media sessions: " + active.size());
                for (MediaController controller : active) {
                    registerMediaControllerCallback(controller);
                }
            }
            mediaListenerRegistered = true;
            log(Log.INFO, TAG, "MediaSessionManager listener registered");
        } catch (Throwable t) {
            log(Log.WARN, TAG, "initMediaSessionListener failed: " + t.getClass().getSimpleName());
        }
    }

    private void registerMediaControllerCallback(MediaController controller) {
        if (controller == null) return;
        try {
            controller.registerCallback(new MediaController.Callback() {
                @Override
                public void onPlaybackStateChanged(PlaybackState state) {
                    try {
                        if (state == null) return;
                        String pkg = controller.getPackageName();
                        mediaPlaying = state.getState() == PlaybackState.STATE_PLAYING;
                        mediaPackage = safeString(pkg);
                        mediaApp = safeString(resolveAppLabel(pkg));
                        mediaState = safeString(playbackStateName(state));
                        MediaMetadata metadata = controller.getMetadata();
                        if (metadata != null) {
                            mediaTitle = safeString(firstNonBlank(
                                    mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_DISPLAY_TITLE),
                                    mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_TITLE)));
                            mediaArtist = safeString(firstNonBlank(
                                    mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_ARTIST),
                                    mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_AUTHOR),
                                    mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_ALBUM_ARTIST)));
                        }
                        maybeDirectUpload(false);
                    } catch (Throwable t) {
                        log(Log.WARN, TAG, "onPlaybackStateChanged failed: " + t.getClass().getSimpleName());
                    }
                }

                @Override
                public void onMetadataChanged(MediaMetadata metadata) {
                    try {
                        if (metadata == null) return;
                        String pkg = controller.getPackageName();
                        mediaPackage = safeString(pkg);
                        mediaApp = safeString(resolveAppLabel(pkg));
                        mediaTitle = safeString(firstNonBlank(
                                mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_DISPLAY_TITLE),
                                mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_TITLE)));
                        mediaArtist = safeString(firstNonBlank(
                                mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_ARTIST),
                                mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_AUTHOR),
                                mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_ALBUM_ARTIST)));
                        maybeDirectUpload(false);
                    } catch (Throwable t) {
                        log(Log.WARN, TAG, "onMetadataChanged failed: " + t.getClass().getSimpleName());
                    }
                }
            });
        } catch (Throwable ignored) {}
    }

    private String mediaTextFromMeta(MediaMetadata metadata, String key) {
        try {
            CharSequence value = metadata.getText(key);
            return value != null ? value.toString() : null;
        } catch (Throwable ignored) {
            return null;
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

            // Hook 1: Activity#setTitle(CharSequence)
            Method setTitleText = activity.getDeclaredMethod("setTitle", CharSequence.class);
            try { deoptimize(setTitleText); } catch (Throwable ignored) {}
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
                            publishBrowserTitle((Activity) owner, packageName, title.toString());
                        }
                        return result;
                    });

            // Hook 2: Activity#setTitle(int)
            Method setTitleRes = activity.getDeclaredMethod("setTitle", int.class);
            try { deoptimize(setTitleRes); } catch (Throwable ignored) {}
            hook(setTitleRes)
                    .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                    .intercept(chain -> {
                        Object result = chain.proceed();
                        Object owner = chain.getThisObject();
                        if (owner instanceof Activity) {
                            CharSequence title = ((Activity) owner).getTitle();
                            if (title != null) publishBrowserTitle((Activity) owner, packageName, title.toString());
                        }
                        return result;
                    });

            // Hook 3: Activity#setTaskDescription — browsers set page title here
            Method setTaskDesc = activity.getDeclaredMethod("setTaskDescription",
                    Class.forName("android.app.ActivityManager$TaskDescription", false, cl));
            try { deoptimize(setTaskDesc); } catch (Throwable ignored) {}
            hook(setTaskDesc)
                    .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                    .intercept(chain -> {
                        Object result = chain.proceed();
                        try {
                            Object owner = chain.getThisObject();
                            List<Object> args = chain.getArgs();
                            if (owner instanceof Activity && args.size() > 0 && args.get(0) != null) {
                                Object td = args.get(0);
                                java.lang.reflect.Method getLabel = td.getClass().getMethod("getLabel");
                                Object label = getLabel.invoke(td);
                                if (label instanceof CharSequence && ((CharSequence) label).length() > 0) {
                                    publishBrowserTitle((Activity) owner, packageName, label.toString());
                                }
                            }
                        } catch (Throwable ignored) {}
                        return result;
                    });

            // Hook 4: Activity#onWindowFocusChanged
            Method focusChanged = activity.getDeclaredMethod("onWindowFocusChanged", boolean.class);
            try { deoptimize(focusChanged); } catch (Throwable ignored) {}
            hook(focusChanged)
                    .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                    .intercept(chain -> {
                        Object result = chain.proceed();
                        List<Object> args = chain.getArgs();
                        boolean hasFocus = args.size() > 0 && Boolean.TRUE.equals(args.get(0));
                        Object owner = chain.getThisObject();
                        if (hasFocus && owner instanceof Activity) {
                            CharSequence title = ((Activity) owner).getTitle();
                            if (title != null) publishBrowserTitle((Activity) owner, packageName, title.toString());
                        }
                        return result;
                    });

            // Hook 5: Window#setTitle
            try {
                Class<?> window = Class.forName("android.view.Window", false, cl);
                Method windowSetTitle = window.getDeclaredMethod("setTitle", CharSequence.class);
                try { deoptimize(windowSetTitle); } catch (Throwable ignored) {}
                hook(windowSetTitle)
                        .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                        .intercept(chain -> {
                            Object result = chain.proceed();
                            try {
                                List<Object> args = chain.getArgs();
                                if (args.size() > 0 && args.get(0) instanceof CharSequence) {
                                    String title = args.get(0).toString();
                                    Object windowObj = chain.getThisObject();
                                    java.lang.reflect.Method getContext = windowObj.getClass().getMethod("getContext");
                                    Object ctx = getContext.invoke(windowObj);
                                    if (ctx instanceof Activity) {
                                        publishBrowserTitle((Activity) ctx, packageName, title);
                                    }
                                }
                            } catch (Throwable ignored) {}
                            return result;
                        });
            } catch (Throwable ignored) {}

            // Hook 6: WebChromeClient#onReceivedTitle
            try {
                Class<?> wcc = Class.forName("android.webkit.WebChromeClient", false, cl);
                Method onReceivedTitle = wcc.getDeclaredMethod("onReceivedTitle",
                        Class.forName("android.webkit.WebView", false, cl), String.class);
                try { deoptimize(onReceivedTitle); } catch (Throwable ignored) {}
                hook(onReceivedTitle)
                        .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                        .intercept(chain -> {
                            Object result = chain.proceed();
                            try {
                                List<Object> args = chain.getArgs();
                                if (args.size() > 1 && args.get(1) instanceof String) {
                                    String title = (String) args.get(1);
                                    Object webView = args.get(0);
                                    java.lang.reflect.Method getContext = webView.getClass().getMethod("getContext");
                                    Object ctx = getContext.invoke(webView);
                                    if (ctx instanceof Activity) {
                                        publishBrowserTitle((Activity) ctx, packageName, title);
                                    } else {
                                        // WebView context is not an Activity — use it directly as send context
                                        Context sendCtx = ctx instanceof Context ? (Context) ctx : null;
                                        publishBrowserTitleFromProcess(sendCtx, packageName, title, "");
                                    }
                                }
                            } catch (Throwable ignored) {}
                            return result;
                        });
            } catch (Throwable ignored) {}

            log(Log.INFO, TAG, "installed browser title hooks for " + packageName);
        } catch (Throwable t) {
            log(Log.WARN, TAG, "activity title hook failed for " + packageName + ": " + t.getClass().getSimpleName());
        }
    }

    private void publishBrowserTitle(Activity activity, String packageName, String title) {
        try {
            String clean = cleanTitle(title);
            if (clean == null || isIgnoredPackage(packageName)) return;
            foregroundPackage = packageName;
            foregroundApp = safeString(resolveAppLabel(activity, packageName));
            foregroundActivity = activity.getClass().getName();
            foregroundTitle = clean;
            // Use Activity's application context so getSentFromPackage() returns browser's package
            Context sendContext = null;
            try {
                sendContext = activity.getApplicationContext();
            } catch (Throwable ignored) {}
            if (sendContext == null) sendContext = activity;
            publishBrowserTitleFromProcess(sendContext, packageName, clean, activity.getClass().getName());
        } catch (Throwable t) {
            log(Log.DEBUG, TAG, "publishBrowserTitle failed: " + t.getMessage());
        }
    }

    private void publishBrowserTitleFromProcess(Context context, String packageName, String title, String activityName) {
        try {
            if (context == null) context = getSystemContext();
            if (context == null) return;
            Intent intent = new Intent(ACTION_BROWSER_TITLE);
            intent.putExtra("package_name", packageName);
            intent.putExtra("title", title);
            intent.putExtra("activity", safeString(activityName));
            // Send broadcast using browser's own context (Activity/ApplicationContext).
            // getSentFromPackage() on API 34+ will return the browser's package because
            // we're sending from the browser's own Context, not system_server's.
            context.sendBroadcast(intent);
        } catch (Throwable t) {
            log(Log.DEBUG, TAG, "publishBrowserTitleFromProcess failed: " + t.getMessage());
        }
    }


    private void broadcastSnapshot() {
        try {
            ComponentName top = getTopActivityComponentName();
            String taskDescription = getFocusedTaskDescription();
            long now = System.currentTimeMillis();
            boolean idleCandidate = top == null || isIgnoredPackage(top.getPackageName());

            if (idleCandidate) {
                // Debounce: only report idle after N consecutive idle samples.
                // Avoids noise from momentary launcher flashes / hidden API gaps / split-focus glitches.
                idleConsecutiveCount++;
                if (idleConsecutiveCount < IDLE_DEBOUNCE_COUNT) return; // skip — wait for more samples
                // N consecutive idles reached → commit idle state
                if ("idle".equals(lastForegroundKey) && now - lastForegroundBroadcastAt < BROADCAST_DEBOUNCE_MS) return;
                lastForegroundKey = "idle";
                lastForegroundBroadcastAt = now;
                foregroundPackage = "idle";
                foregroundApp = "idle";
                foregroundActivity = "";
                foregroundTitle = "";
            } else {
                idleConsecutiveCount = 0; // reset on valid foreground
                String packageName = top.getPackageName();
                String activityName = top.getClassName();
                String key = packageName + "/" + activityName;
                if (!key.equals(lastForegroundKey)) {
                    log(Log.INFO, TAG, "foreground: " + key + " title=" + (taskDescription != null ? taskDescription : ""));
                }
                if (key.equals(lastForegroundKey) && now - lastForegroundBroadcastAt < BROADCAST_DEBOUNCE_MS) return;
                lastForegroundKey = key;
                lastForegroundBroadcastAt = now;
                foregroundPackage = packageName;
                foregroundApp = safeString(resolveAppLabel(packageName));
                foregroundActivity = activityName;
                // For browsers, extract page title from Android task description
                // (works for Chrome, Firefox, WebView browsers — Activity.setTitle is unreliable)
                if (isBrowserPackage(packageName) && taskDescription != null && taskDescription.length() > 0) {
                    foregroundTitle = cleanTitle(taskDescription);
                    if (foregroundTitle == null) foregroundTitle = "";
                } else if (!isBrowserPackage(packageName)) {
                    foregroundTitle = "";
                }
                // else: keep previous title if browser package and no new description
            }

            Intent intent = new Intent(ACTION_STATUS);
            intent.setComponent(new ComponentName(TARGET_PACKAGE, TARGET_RECEIVER));
            if (idleCandidate) {
                intent.putExtra("package_name", "idle");
                intent.putExtra("app_name", "idle");
                intent.putExtra("activity", "");
                intent.putExtra("input_active", false);
            } else {
                intent.putExtra("package_name", foregroundPackage);
                intent.putExtra("app_name", foregroundApp);
                intent.putExtra("activity", foregroundActivity);
                intent.putExtra("input_active", false);
                if (foregroundTitle.length() > 0) {
                    intent.putExtra("title", foregroundTitle);
                }
            }
            Context context = getSystemContext();
            if (context != null) {
                long token = Binder.clearCallingIdentity();
                try { context.sendBroadcast(intent); } finally { Binder.restoreCallingIdentity(token); }
            }
            maybeDirectUpload(false);
        } catch (Throwable t) {
            log(Log.WARN, TAG, "broadcast failed: " + t.getClass().getSimpleName());
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

    /**
     * Extract the task description from the focused root task.
     * On Android, browsers set the page title as the task description
     * (visible in the Recent Apps / task switcher). This is the most
     * reliable way to get page titles across Chrome, Firefox, and WebView browsers.
     * 
     * Enhanced with multiple fallback strategies based on open-source analysis:
     * - getFocusedRootTaskInfo() (Android 11+)
     * - getFocusedStackInfo() (Android 10)
     * - getTasks() fallback (Android 9 and below)
     * - ActivityTaskManagerService direct access
     */
    private String getFocusedTaskDescription() {
        try {
            Object service = getActivityTaskManagerService();
            if (service == null) return null;
            
            // Strategy 1: getFocusedRootTaskInfo (Android 11+)
            Object info = callAny(service, "getFocusedRootTaskInfo");
            
            // Strategy 2: getFocusedStackInfo (Android 10)
            if (info == null) {
                info = callAny(service, "getFocusedStackInfo");
            }
            
            // Strategy 3: getTasks() fallback (Android 9 and below)
            if (info == null) {
                try {
                    Method getTasks = service.getClass().getMethod("getTasks", int.class);
                    @SuppressWarnings("unchecked")
                    List<?> tasks = (List<?>) getTasks.invoke(service, 1);
                    if (tasks != null && !tasks.isEmpty()) {
                        Object topTask = tasks.get(0);
                        // Try to get TaskInfo from RunningTaskInfo
                        info = readField(topTask, "taskInfo");
                        if (info == null) info = topTask;
                    }
                } catch (Throwable t) {
                    // Silenced: fires every 5s on devices without getTasks
                }
            }
            
            if (info == null) {
                return null;
            }
            
            // Try multiple field names for TaskDescription
            Object desc = readField(info, "taskDescription");
            if (desc == null) desc = readField(info, "description");
            if (desc == null) desc = readField(info, "origDescription");
            
            if (desc == null) {
                return null;
            }
            
            // desc might be an ActivityManager.TaskDescription object instead of CharSequence
            if (desc != null && !(desc instanceof CharSequence)) {
                try {
                    // Try getLabel() method (standard API)
                    Method getLabel = desc.getClass().getMethod("getLabel");
                    Object label = getLabel.invoke(desc);
                    if (label instanceof CharSequence) {
                        String result = ((CharSequence) label).toString().trim();
                        if (result.length() > 0) {
                            return result;
                        }
                    }
                } catch (Throwable t) {
                    // getLabel() not available on this device — expected on some ROMs
                }
                
                // getLabel() returned null — no useful task description available
            }
            
            if (desc instanceof CharSequence) {
                String s = desc.toString().trim();
                if (s.length() > 0) {
                    return s;
                }
            }
            
            return null;
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * Detect the current windowing mode of the focused task.
     * @return one of: "fullscreen", "split-screen", "freeform", "pip", or null if unknown
     */
    private String getWindowingMode() {
        try {
            Object service = getActivityTaskManagerService();
            if (service == null) return null;
            Object info = callAny(service, "getFocusedRootTaskInfo");
            if (info == null) info = callAny(service, "getFocusedStackInfo");
            if (info == null) return null;
            // Try getWindowingMode() method
            Object mode = callAny(info, "getWindowingMode");
            if (mode == null) mode = readField(info, "mWindowingMode");
            if (mode instanceof Integer) {
                int m = (Integer) mode;
                switch (m) {
                    case 1: return "fullscreen";
                    case 2: return "split-screen";
                    case 3: return "split-screen-secondary"; // Android 14+
                    case 4: return "split-screen-primary";   // Android 14+
                    case 5: return "freeform";
                    case 6: return "pip";
                    default: return "mode_" + m;
                }
            }
            return null;
        } catch (Throwable ignored) {
            return null;
        }
    }

    /**
     * Detect device form factor: "phone", "tablet", or "foldable".
     * Uses MIUI-specific detection first, falls back to AOSP screen size.
     */
    private String getDeviceFormFactor() {
        try {
            // MIUI: miui.os.Build.IS_TABLET (most reliable for Xiaomi devices)
            Class<?> miuiBuild = Class.forName("miui.os.Build");
            Object isTablet = miuiBuild.getDeclaredField("IS_TABLET").get(null);
            if (Boolean.TRUE.equals(isTablet)) return "tablet";
        } catch (Throwable ignored) {}
        try {
            // AOSP: smallest width >= 600dp = tablet
            Context ctx = getSystemContext();
            if (ctx != null) {
                android.content.res.Configuration config = ctx.getResources().getConfiguration();
                if (config.smallestScreenWidthDp >= 600) return "tablet";
            }
        } catch (Throwable ignored) {}
        try {
            // Detect foldable via PackageManager feature
            Context ctx = getSystemContext();
            if (ctx != null) {
                boolean hasFold = ctx.getPackageManager().hasSystemFeature("com.sec.feature.foldable_display")
                    || ctx.getPackageManager().hasSystemFeature("org.chromium.arc")
                    || ctx.getPackageManager().hasSystemFeature("android.hardware.type.pc");
                // Check screen width in landscape
                android.content.res.Configuration config = ctx.getResources().getConfiguration();
                int screenWidth = config.screenWidthDp;
                if ((hasFold || screenWidth >= 800) && config.smallestScreenWidthDp >= 600) return "tablet";
            }
        } catch (Throwable ignored) {}
        return "phone";
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

    private void loadDirectUploadConfig() {
        try {
            // Priority 1: Read from device-protected storage
            Context context = getSystemContext();
            if (context != null) {
                try {
                    SharedPreferences dps = context.createDeviceProtectedStorageContext()
                            .getSharedPreferences("monika_lsp_direct_upload", Context.MODE_PRIVATE);
                    if (dps.contains("enabled")) {
                        directUploadEnabled = dps.getBoolean("enabled", false);
                        directServerUrl = dps.getString("server_url", "");
                        directToken = dps.getString("token", "");
                        directIntervalMs = Math.max(MIN_DIRECT_UPLOAD_MS, dps.getLong("interval_ms", 30000L));
                        directUploadForeground = dps.getBoolean("upload_foreground", true);
                        directUploadMedia = dps.getBoolean("upload_media", true);
                        log(Log.INFO, TAG, "config loaded from DPS: enabled=" + directUploadEnabled);
                        return;
                    }
                } catch (Throwable ignored) {}
            }
            // Priority 2: Fallback to getRemotePreferences
            SharedPreferences prefs = getRemotePreferences("monika_lsp_direct_upload");
            directUploadEnabled = prefs.getBoolean("enabled", false);
            directServerUrl = prefs.getString("server_url", "");
            directToken = prefs.getString("token", "");
            directIntervalMs = Math.max(MIN_DIRECT_UPLOAD_MS, prefs.getLong("interval_ms", 30000L));
            directUploadForeground = prefs.getBoolean("upload_foreground", true);
            directUploadMedia = prefs.getBoolean("upload_media", true);
            log(Log.INFO, TAG, "config loaded from remote prefs: enabled=" + directUploadEnabled);
        } catch (Throwable t) {
            log(Log.WARN, TAG, "load config failed: " + Log.getStackTraceString(t));
        }
    }

    private void saveDirectUploadConfig(Context context, Intent intent) {
        try {
            boolean enabled = intent.getBooleanExtra("enabled", false);
            String serverUrl = safeString(intent.getStringExtra("server_url")).replaceAll("/+$", "");
            String token = safeString(intent.getStringExtra("token"));
            int intervalSec = intent.getIntExtra("interval_sec", 30);
            boolean uploadForeground = intent.getBooleanExtra("upload_foreground", true);
            boolean uploadMedia = intent.getBooleanExtra("upload_media", true);

            // Disconnect old WS before changing config (URL/token may have changed)
            boolean configChanged = !serverUrl.equals(directServerUrl) || !token.equals(directToken) || enabled != directUploadEnabled;
            if (configChanged && wsClient != null) {
                try { wsClient.disconnect(); } catch (Throwable ignored) {}
                wsClient = null;
            }
            // If disabled, disconnect and clear
            if (!enabled && wsClient != null) {
                try { wsClient.disconnect(); } catch (Throwable ignored) {}
                wsClient = null;
            }

            // Write to system_server device-protected storage for persistence across reboots
            try {
                SharedPreferences prefs = context.createDeviceProtectedStorageContext()
                        .getSharedPreferences("monika_lsp_direct_upload", Context.MODE_PRIVATE);
                prefs.edit()
                        .putBoolean("enabled", enabled)
                        .putString("server_url", serverUrl)
                        .putString("token", token)
                        .putLong("interval_ms", Math.max(MIN_DIRECT_UPLOAD_MS, intervalSec * 1000L))
                        .putBoolean("upload_foreground", uploadForeground)
                        .putBoolean("upload_media", uploadMedia)
                        .commit();
            } catch (Throwable ignored) {}

            // IMPORTANT: Set volatile fields directly from broadcast extras.
            // Do NOT rely on getRemotePreferences() to read back from the above storage,
            // because it may read from a different storage location (LSPosed framework
            // storage vs system_server device-protected storage).
            directUploadEnabled = enabled;
            directServerUrl = serverUrl;
            directToken = token;
            directIntervalMs = Math.max(MIN_DIRECT_UPLOAD_MS, intervalSec * 1000L);
            directUploadForeground = uploadForeground;
            directUploadMedia = uploadMedia;
            log(Log.INFO, TAG, "config applied from broadcast: enabled=" + enabled + " url=" + serverUrl + " token=" + (token.length() > 0 ? "set" : "empty"));

            maybeDirectUpload(true);
        } catch (Throwable t) {
            log(Log.WARN, TAG, "save config failed: " + t.getClass().getSimpleName());
        }
    }

    private void maybeDirectUpload(boolean force) {
        if (!directUploadEnabled || directServerUrl.length() == 0 || directToken.length() == 0) return;
        long now = System.currentTimeMillis();
        long safeInterval = Math.max(MIN_DIRECT_UPLOAD_MS, directIntervalMs);
        if (!force && now - lastDirectUploadAt < safeInterval) return;
        lastDirectUploadAt = now;
        final String body = buildDirectReportBody(now);
        if (body == null) return;

        // Diagnostic log: show what we're about to upload
        try {
            org.json.JSONObject diag = new org.json.JSONObject(body);
            log(Log.INFO, TAG, "upload: app_id=" + diag.optString("app_id") + " title=" + diag.optString("window_title"));
        } catch (Throwable ignored) {}

        // Use dedicated upload HandlerThread (single background thread, no unbounded spawning).
        final String url = directServerUrl;
        final String tok = directToken;
        getUploadHandler().post(() -> {
            ensureWsConnected(url, tok);
            final LspWebSocketClient client = wsClient;
            if (client != null && client.isConnected()) {
                try {
                    String msg = new org.json.JSONObject()
                            .put("type", "device_status")
                            .put("payload", new org.json.JSONObject(body))
                            .toString();
                    if (client.sendText(msg)) {
                        log(Log.DEBUG, TAG, "ws upload OK");
                    } else {
                        postDirectReportFallback(body);
                    }
                } catch (Throwable t) {
                    log(Log.WARN, TAG, "ws send failed: " + t.getClass().getSimpleName());
                    postDirectReportFallback(body);
                }
            } else {
                postDirectReportFallback(body);
                log(Log.INFO, TAG, "http fallback upload attempted");
            }
        });
    }

    private String buildDirectReportBody(long now) {
        try {
            String appId = directUploadForeground ? safeString(foregroundPackage) : "";
            boolean foregroundIsIdle = appId.length() == 0 || "idle".equals(appId);
            if (foregroundIsIdle) {
                // When idle but media is playing, use the media package as app_id.
                // Avoids displaying "idle" when user is actually listening.
                if (directUploadMedia && mediaPlaying && mediaPackage.length() > 0) {
                    appId = mediaPackage;
                } else {
                    appId = "idle";
                }
            }
            String windowTitle = primaryDisplayTitle();
            JSONObject extra = new JSONObject();
            JSONObject device = new JSONObject();
            device.put("capability_mode", "lsposed");
            device.put("uploader", "lsposed");
            device.put("last_sample_at", isoTime(now));
            // Multi-window / tablet detection
            device.put("device_kind", getDeviceFormFactor());
            String wm = getWindowingMode();
            if (wm != null) device.put("window_mode", wm);
            extra.put("device", device);
            if (directUploadForeground && foregroundPackage.length() > 0 && !"idle".equals(foregroundPackage)) {
                JSONObject foreground = new JSONObject();
                foreground.put("package_name", foregroundPackage);
                if (foregroundApp.length() > 0) foreground.put("app_name", foregroundApp);
                if (foregroundActivity.length() > 0) foreground.put("activity", foregroundActivity);
                if (foregroundTitle.length() > 0) foreground.put("title", foregroundTitle);
                foreground.put("source", "lsposed");
                foreground.put("confidence", 0.95);
                extra.put("foreground", foreground);
            }
            // Only include media info when actively playing — avoids showing stale paused data
            if (directUploadMedia && mediaPlaying && mediaTitle.length() > 0) {
                JSONObject media = new JSONObject();
                media.put("playing", mediaPlaying);
                if (mediaTitle.length() > 0) media.put("title", mediaTitle);
                if (mediaArtist.length() > 0) media.put("artist", mediaArtist);
                if (mediaApp.length() > 0) media.put("app", mediaApp);
                if (mediaPackage.length() > 0) media.put("package_name", mediaPackage);
                if (mediaState.length() > 0) media.put("state", mediaState);
                media.put("source", "lsposed");
                extra.put("media", media);
            }
            return new JSONObject()
                    .put("app_id", appId)
                    .put("window_title", windowTitle)
                    .put("timestamp", isoTime(now))
                    .put("extra", extra)
                    .toString();
        } catch (Throwable t) {
            log(Log.WARN, TAG, "build direct body failed: " + t.getClass().getSimpleName());
            return null;
        }
    }

    private void postDirectReportFallback(String body) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(directServerUrl + "/api/report");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Authorization", "Bearer " + directToken);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            connection.getOutputStream().write(bytes);
            int code = connection.getResponseCode();
            if (code >= 200 && code < 300) {
                log(Log.DEBUG, TAG, "http upload OK");
            } else {
                log(Log.WARN, TAG, "http upload HTTP " + code);
            }
        } catch (Throwable t) {
            log(Log.WARN, TAG, "http fallback upload failed: " + t.getClass().getSimpleName());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void ensureWsConnected(String serverUrl, String token) {
        if (wsClient != null && wsClient.isConnected()) {
            wsRetryDelayMs = WS_RETRY_BASE_MS; // reset on success
            return;
        }
        // Backoff: don't hammer WS handshake on repeated failures
        long now = System.currentTimeMillis();
        if (wsLastFailAt > 0 && now - wsLastFailAt < wsRetryDelayMs) {
            return; // still in backoff window — skip WS, caller falls back to HTTP
        }
        synchronized (this) {
            if (wsClient != null && wsClient.isConnected()) return;
            if (wsClient != null) {
                try { wsClient.disconnect(); } catch (Throwable ignored) {}
            }
            try {
                String wsUrl = buildLspWsUrl(serverUrl);
                wsClient = new LspWebSocketClient(wsUrl, "Bearer " + token);
                wsClient.connect();
                wsRetryDelayMs = WS_RETRY_BASE_MS; // reset on success
                wsLastFailAt = 0L;
                log(Log.INFO, TAG, "LSP WS connected to " + wsUrl);
            } catch (Throwable t) {
                wsClient = null;
                wsLastFailAt = System.currentTimeMillis();
                wsRetryDelayMs = Math.min(wsRetryDelayMs * 2, WS_RETRY_MAX_MS);
                log(Log.WARN, TAG, "LSP WS connect failed (retry in " + (wsRetryDelayMs / 1000) + "s): " + t.getClass().getSimpleName());
            }
        }
    }

    private String buildLspWsUrl(String serverUrl) {
        String base = serverUrl.replaceAll("/+$", "");
        if (base.toLowerCase().startsWith("https://")) {
            return "wss://" + base.substring(8) + "/api/ws?role=device";
        } else if (base.toLowerCase().startsWith("http://")) {
            return "ws://" + base.substring(7) + "/api/ws?role=device";
        }
        return "wss://" + base + "/api/ws?role=device";
    }

    private String primaryDisplayTitle() {
        boolean foregroundValid = foregroundApp.length() > 0
                && !"idle".equals(foregroundPackage)
                && !"idle".equals(foregroundApp);
        if (foregroundValid && mediaPlaying && mediaTitle.length() > 0 && mediaApp.length() > 0 && !mediaApp.equals(foregroundApp)) {
            return "正在用" + foregroundApp + "，后台" + mediaApp + "正在播放" + mediaTitle;
        }
        if (foregroundValid && mediaPlaying && mediaTitle.length() > 0) {
            return "正在用" + foregroundApp + "播放" + mediaTitle;
        }
        if (!foregroundValid && mediaPlaying && mediaTitle.length() > 0 && mediaApp.length() > 0) {
            return mediaApp + "正在播放" + mediaTitle;
        }
        if (!foregroundValid && mediaPlaying && mediaTitle.length() > 0) {
            return "正在播放" + mediaTitle;
        }
        if (foregroundValid && foregroundTitle.length() > 0) {
            return "正在用" + foregroundApp + "看" + foregroundTitle;
        }
        if (foregroundValid) return "正在用" + foregroundApp;
        if ("idle".equals(foregroundPackage) || "idle".equals(foregroundApp)) return "暂时离开";
        return "";
    }

    private String isoTime(long millis) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new java.util.Date(millis));
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

    private String safeString(String value) {
        return value == null ? "" : value.trim();
    }

    private boolean isIgnoredPackage(String packageName) {
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

    // ──────────────────────────────────────────────
    //  Minimal WebSocket client for LSPosed data upload
    //  Uses javax.net.ssl.SSLSocket — no external dependencies
    // ──────────────────────────────────────────────
    private class LspWebSocketClient {
        private static final int OP_TEXT  = 0x1;
        private static final int OP_CLOSE = 0x8;
        private static final int OP_PING  = 0x9;
        private static final int OP_PONG  = 0xA;
        private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
        private static final int RECEIVE_BUF = 8192;
        private final byte[] recvBuf = new byte[RECEIVE_BUF];

        private final String wsUrl;
        private final String authHeader;
        private final SecureRandom secureRandom = new SecureRandom();
        private java.net.Socket socket;
        private InputStream in;
        private OutputStream out;
        private Thread readerThread;
        private volatile boolean connected;
        private volatile boolean running;

        LspWebSocketClient(String wsUrl, String authHeader) {
            this.wsUrl = wsUrl;
            this.authHeader = authHeader;
        }

        boolean isConnected() {
            return connected && socket != null && !socket.isClosed() && socket.isConnected();
        }

        void connect() throws Exception {
            URI uri = URI.create(wsUrl);
            String host = uri.getHost();
            String scheme = uri.getScheme();
            boolean isWss = "wss".equalsIgnoreCase(scheme);
            int defaultPort = isWss ? 443 : 80;
            int port = uri.getPort() > 0 ? uri.getPort() : defaultPort;
            String path = uri.getRawPath();
            String query = uri.getRawQuery();
            String resource = path + (query != null ? "?" + query : "");
            if (resource.isEmpty()) resource = "/";

            if (isWss) {
                SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
                SSLSocket ssl = (SSLSocket) factory.createSocket();
                ssl.setTcpNoDelay(true);
                ssl.setSoTimeout(0);
                // SNI (Server Name Indication) — required for virtual-hosted TLS.
                // Skip SNI for IP addresses (SNIHostName throws on raw IP).
                boolean isIp = host.matches("[0-9.]+|[:0-9a-fA-F]+");
                javax.net.ssl.SSLParameters params = ssl.getSSLParameters();
                if (!isIp) {
                    params.setServerNames(java.util.Collections.singletonList(
                        new javax.net.ssl.SNIHostName(host)));
                }
                // Hostname verification — prevents MITM with valid cert for wrong host
                params.setEndpointIdentificationAlgorithm("HTTPS");
                ssl.setSSLParameters(params);
                ssl.connect(new InetSocketAddress(host, port), 8000);
                ssl.startHandshake();
                // Verify hostname post-handshake (defense-in-depth)
                javax.net.ssl.HostnameVerifier verifier = javax.net.ssl.HttpsURLConnection.getDefaultHostnameVerifier();
                if (!verifier.verify(host, ssl.getSession())) {
                    throw new IOException("Hostname verification failed: " + host);
                }
                socket = ssl;
            } else {
                java.net.Socket plain = new java.net.Socket();
                plain.setTcpNoDelay(true);
                plain.setSoTimeout(0);
                plain.connect(new InetSocketAddress(host, port), 8000);
                socket = plain;
            }
            in = socket.getInputStream();
            out = socket.getOutputStream();

            // WebSocket handshake
            byte[] keyBytes = new byte[16];
            secureRandom.nextBytes(keyBytes);
            String secKey = Base64.getEncoder().encodeToString(keyBytes);

            StringBuilder req = new StringBuilder();
            req.append("GET ").append(resource).append(" HTTP/1.1\r\n");
            req.append("Host: ").append(host);
            if (port != 443 && port != 80) req.append(":").append(port);
            req.append("\r\n");
            req.append("Upgrade: websocket\r\n");
            req.append("Connection: Upgrade\r\n");
            req.append("Sec-WebSocket-Key: ").append(secKey).append("\r\n");
            req.append("Sec-WebSocket-Version: 13\r\n");
            req.append("Authorization: ").append(authHeader).append("\r\n");
            req.append("\r\n");

            out.write(req.toString().getBytes(StandardCharsets.UTF_8));
            out.flush();

            // Read HTTP response
            StringBuilder response = new StringBuilder();
            int b;
            while ((b = in.read()) != -1) {
                response.append((char) b);
                String s = response.toString();
                if (s.endsWith("\r\n\r\n")) break;
                if (s.length() > 8192) throw new IOException("response too large");
            }

            String respStr = response.toString();
            if (!respStr.contains("101")) {
                throw new IOException("handshake failed: " + respStr.split("\r\n")[0]);
            }

            // Verify Sec-WebSocket-Accept
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            sha1.update((secKey + WS_GUID).getBytes(StandardCharsets.UTF_8));
            String expectedAccept = Base64.getEncoder().encodeToString(sha1.digest());
            if (!respStr.contains(expectedAccept)) {
                throw new IOException("Sec-WebSocket-Accept mismatch");
            }

            // Start reader thread
            running = true;
            connected = true;
            readerThread = new Thread(this::readerLoop, "LspWsReader");
            readerThread.setDaemon(true);
            readerThread.start();
        }

        void disconnect() {
            running = false;
            connected = false;
            try {
                if (out != null) {
                    sendCloseFrame(1000, "done");
                }
            } catch (Throwable ignored) {}
            closeQuietly();
        }

        private void closeQuietly() {
            try { if (in != null) in.close(); } catch (Throwable ignored) {}
            try { if (out != null) out.close(); } catch (Throwable ignored) {}
            try { if (socket != null) socket.close(); } catch (Throwable ignored) {}
            in = null;
            out = null;
            socket = null;
        }

        boolean sendText(String text) {
            if (!connected || out == null) return false;
            try {
                byte[] payload = text.getBytes(StandardCharsets.UTF_8);
                synchronized (out) {
                    sendFrame(OP_TEXT, payload, true);
                    out.flush();
                }
                return true;
            } catch (Throwable t) {
                connected = false;
                closeQuietly();
                return false;
            }
        }

        private void sendCloseFrame(int code, String reason) {
            try {
                byte[] reasonBytes = reason != null ? reason.getBytes(StandardCharsets.UTF_8) : new byte[0];
                byte[] payload = new byte[2 + reasonBytes.length];
                payload[0] = (byte) ((code >> 8) & 0xFF);
                payload[1] = (byte) (code & 0xFF);
                System.arraycopy(reasonBytes, 0, payload, 2, reasonBytes.length);
                synchronized (out) {
                    sendFrame(OP_CLOSE, payload, true);
                    out.flush();
                }
            } catch (Throwable ignored) {}
        }

        private void sendFrame(int opcode, byte[] payload, boolean mask) throws IOException {
            int len = payload != null ? payload.length : 0;
            // Byte 0: FIN(0x80) | opcode
            out.write(0x80 | opcode);

            // Byte 1 + extended length
            int maskBit = mask ? 0x80 : 0x00;
            if (len < 126) {
                out.write(maskBit | len);
            } else if (len <= 0xFFFF) {
                out.write(maskBit | 126);
                out.write((len >> 8) & 0xFF);
                out.write(len & 0xFF);
            } else {
                out.write(maskBit | 127);
                for (int i = 7; i >= 0; i--) {
                    out.write((int) ((len >> (i * 8)) & 0xFF));
                }
            }

            // Masking key (client MUST mask)
            byte[] maskKey = null;
            if (mask) {
                maskKey = new byte[4];
                secureRandom.nextBytes(maskKey);
                out.write(maskKey);
            }

            // Payload (masked if client)
            if (payload != null && len > 0) {
                if (mask) {
                    byte[] masked = new byte[len];
                    for (int i = 0; i < len; i++) {
                        masked[i] = (byte) (payload[i] ^ maskKey[i % 4]);
                    }
                    out.write(masked);
                } else {
                    out.write(payload);
                }
            }
        }

        private void readerLoop() {
            try {
                while (running && connected) {
                    byte[] frame = readFrame();
                    if (frame == null) break;
                    int opcode = frame[0] & 0x0F;
                    int payloadLen = frame.length - 1;
                    byte[] payload = payloadLen > 0 ? new byte[payloadLen] : new byte[0];
                    if (payloadLen > 0) System.arraycopy(frame, 1, payload, 0, payloadLen);

                    switch (opcode) {
                        case OP_PING:
                            // Respond with pong (echo the ping payload).
                            // CRITICAL: per RFC 6455 §5.5, client-to-server frames MUST be masked.
                            try {
                                synchronized (out) {
                                    sendFrame(OP_PONG, payload, true);
                                    out.flush();
                                }
                            } catch (Throwable t) {
                                connected = false;
                                return;
                            }
                            break;
                        case OP_PONG:
                            // Server responded to our ping — connection is alive
                            break;
                        case OP_CLOSE:
                            // Server closed
                            connected = false;
                            running = false;
                            closeQuietly();
                            // Signal reconnect on next maybeDirectUpload
                            MonikaXposedModule.this.wsClient = null;
                            return;
                        default:
                            // Ignore other frame types (ack, messages, etc.)
                            break;
                    }
                }
            } catch (Throwable t) {
                // Connection lost — signal reconnect
                connected = false;
            } finally {
                connected = false;
                closeQuietly();
                MonikaXposedModule.this.wsClient = null;
            }
        }

        private byte[] readFrame() throws IOException {
            if (in == null) return null;

            // Read first 2 bytes
            int b0 = in.read();
            if (b0 < 0) return null;
            int opcode = b0 & 0x0F;
            int b1 = in.read();
            if (b1 < 0) return null;
            boolean masked = (b1 & 0x80) != 0;
            int len = b1 & 0x7F;

            // Read extended length
            if (len == 126) {
                len = ((in.read() & 0xFF) << 8) | (in.read() & 0xFF);
            } else if (len == 127) {
                long longLen = 0;
                for (int i = 0; i < 8; i++) {
                    longLen = (longLen << 8) | (in.read() & 0xFF);
                }
                if (longLen > Integer.MAX_VALUE) throw new IOException("frame too large");
                len = (int) longLen;
            }

            // Read mask key (server frames shouldn't be masked, but spec allows)
            byte[] maskKey = null;
            if (masked) {
                maskKey = new byte[4];
                for (int i = 0; i < 4; i++) {
                    int mk = in.read();
                    if (mk < 0) return null;
                    maskKey[i] = (byte) mk;
                }
            }

            // Read payload
            byte[] result = new byte[1 + len];
            result[0] = (byte) opcode;
            if (len > 0) {
                int offset = 1;
                int remaining = len;
                while (remaining > 0) {
                    int read = in.read(recvBuf, 0, Math.min(recvBuf.length, remaining));
                    if (read < 0) return null;
                    if (masked) {
                        for (int i = 0; i < read; i++) {
                            recvBuf[i] ^= maskKey[(offset - 1 + i) % 4];
                        }
                    }
                    System.arraycopy(recvBuf, 0, result, offset, read);
                    offset += read;
                    remaining -= read;
                }
            }
            return result;
        }
    }
}
