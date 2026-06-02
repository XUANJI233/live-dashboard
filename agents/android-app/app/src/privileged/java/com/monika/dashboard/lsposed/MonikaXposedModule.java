package com.monika.dashboard.lsposed;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Intent;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.ComponentName;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Binder;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.PowerManager;
import android.telephony.TelephonyManager;
import android.text.InputType;
import android.util.Log;
import android.view.inputmethod.EditorInfo;

import androidx.annotation.NonNull;

import com.monika.dashboard.BuildConfig;

import java.lang.reflect.Field;
import java.util.concurrent.ConcurrentHashMap;
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
import java.io.ByteArrayOutputStream;

import io.github.libxposed.api.XposedInterface;
import io.github.libxposed.api.XposedModule;
import io.github.libxposed.api.XposedModuleInterface;
import org.json.JSONArray;
import org.json.JSONObject;

public final class MonikaXposedModule extends XposedModule {
    private static final String TAG = "MonikaLSP";
    private static final String TARGET_PACKAGE = BuildConfig.APPLICATION_ID;
    private static final String TARGET_RECEIVER = TARGET_PACKAGE + ".system.LsposedBridgeReceiver";
    private static final String ACTION_STATUS = "com.monika.dashboard.LSPOSED_STATUS";
    private static final String ACTION_MESSAGE = "com.monika.dashboard.LSPOSED_MESSAGE";
    private static final String ACTION_CONFIG = "com.monika.dashboard.LSPOSED_CONFIG";
    private static final String ACTION_BROWSER_TITLE = "com.monika.dashboard.LSPOSED_BROWSER_TITLE";
    private static final String CONFIG_PERMISSION = "com.monika.dashboard.permission.LSPOSED_CONFIG";
    private static final String MESSAGE_CHANNEL_ID = "monika_lsp_messages";
    private static final int MESSAGE_NOTIFICATION_ID = 2002;
    private static final long HEARTBEAT_MS = 5 * 60_000L; // low-frequency fallback; events drive normal uploads
    private static final long BROADCAST_DEBOUNCE_MS = 1500L;
    private static final long MIN_DIRECT_UPLOAD_MS = 5000L;
    private static final long MAX_DIRECT_UPLOAD_MS = 45_000L;
    private static final long IDLE_DEBOUNCE_COUNT = 2; // 2 consecutive heartbeats before reporting idle
    private static final long WS_RETRY_BASE_MS = 30_000L;  // first retry delay
    private static final long WS_RETRY_MAX_MS = 300_000L;  // max retry delay (5 min)
    
    // Static instance for global access
    private static MonikaXposedModule instance;
    
    private volatile boolean foregroundRecentlyChanged = false;
    private volatile int idleConsecutiveCount = 0;
    private volatile long wsLastFailAt = 0L;
    private volatile long wsRetryDelayMs = WS_RETRY_BASE_MS;
    private static final String[] BROWSER_PACKAGES = new String[] {
            "com.android.browser",
            "com.mi.globalbrowser",
            "com.mi.browser",
            "com.heytap.browser",
            "com.vivo.browser",
            "com.huawei.browser",
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
            "com.quark.browser",
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
    private volatile boolean screenReceiverRegistered = false;
    private final java.util.Set<String> registeredMediaControllers =
            java.util.Collections.synchronizedSet(new java.util.HashSet<>());
    private final java.util.Set<String> hookedWebChromeClientClasses =
            java.util.Collections.synchronizedSet(new java.util.HashSet<>());
    private final java.util.Set<String> hookedWebViewClientClasses =
            java.util.Collections.synchronizedSet(new java.util.HashSet<>());
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
    private volatile boolean directUploadNetwork = true;
    private volatile boolean directUploadVpn = false;
    private volatile boolean directUploadInput = false;
    private volatile long lastDirectUploadAt = 0L;
    private volatile String pendingDirectBody = "";
    private volatile LspWebSocketClient wsClient = null;
    private volatile boolean wsReconnectPending = false;
    private volatile String foregroundPackage = "";
    private volatile String foregroundApp = "";
    private volatile String foregroundActivity = "";
    private volatile String foregroundTitle = "";
    private volatile boolean mediaPlaying = false;
    private volatile boolean inputActive = false;
    private volatile String mediaPackage = "";
    private volatile String mediaApp = "";
    private volatile String mediaTitle = "";
    private volatile String mediaArtist = "";
    private volatile String mediaState = "";
    private volatile long lastTitleBroadcastAt = 0L;
    private volatile String lastBroadcastTitle = "";
    private volatile String recentForegroundBrowser = "";
    private volatile long recentForegroundBrowserAt = 0L;
    private volatile long lastScreenOffCheckAt = 0L;
    private static final long SCREEN_OFF_DEBOUNCE_MS = 30_000L; // 30s debounce for sleep detection
    private static final long TOP_ACTIVITY_FALLBACK_MS = 120_000L;
    private volatile ComponentName lastKnownTopComponent = null;
    private volatile long lastKnownTopAt = 0L;
    private static final Object REFLECTION_MISS = new Object();
    private static final String NO_ARG_SIG = "#";
    private final ConcurrentHashMap<String, Object> classCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Object> methodLookupCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Object> fieldLookupCache = new ConcurrentHashMap<>();

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
        installInputMethodHooks(cl);
    }

    @Override
    public void onPackageReady(@NonNull XposedModuleInterface.PackageReadyParam param) {
        String packageName = param.getPackageName();
        if (!isBrowserPackage(packageName)) return;
        // Hook likely browser UI processes only. Some OEM/system browsers keep their UI in
        // a named process, while renderer/gpu/sandbox/service processes must be ignored.
        String processName = currentProcessName;
        if (!shouldHookBrowserProcess(packageName, processName)) {
            log(Log.DEBUG, TAG, "skip browser non-main process: " + packageName + "/" + processName);
            return;
        }
        installActivityTitleHooks(param.getClassLoader(), packageName);
    }

    private boolean shouldHookBrowserProcess(String packageName, String processName) {
        if (processName == null || processName.length() == 0 || packageName.equals(processName)) {
            return true;
        }
        if (!processName.startsWith(packageName + ":")) {
            return false;
        }
        String suffix = processName.substring(packageName.length() + 1).toLowerCase(Locale.US);
        if (suffix.length() == 0) return true;
        return !suffix.contains("renderer")
                && !suffix.contains("sandbox")
                && !suffix.contains("gpu")
                && !suffix.contains("zygote")
                && !suffix.contains("privileged_process")
                && !suffix.contains("utility")
                && !suffix.contains("crash")
                && !suffix.contains("download")
                && !suffix.contains("push")
                && !suffix.contains("service");
    }

    private void installForegroundSampler(ClassLoader cl) {
        try {
            Class<?> clazz = cachedClassForName("com.android.server.wm.ActivityTaskManagerService", cl);
            if (clazz == null) throw new ClassNotFoundException("ActivityTaskManagerService");

            // Hook systemReady to start the sampler
            Method systemReady = findMethod(clazz, "systemReady");
            if (systemReady != null) {
                try { deoptimize(systemReady); } catch (Throwable ignored) {}
                hook(systemReady)
                        .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                        .intercept(chain -> {
                            Object result = chain.proceed();
                            startForegroundSampler();
                            return result;
                        });
                log(Log.INFO, TAG, "hooked ActivityTaskManagerService#systemReady");
            } else {
                startForegroundSampler();
            }

            // Event-driven: hook moveTaskToFront to detect foreground changes immediately
            // This eliminates frequent sampling when the foreground is stable.
            // IApplicationThread is a hidden API — resolve once and keep it in the class cache.
            Method moveToFront = null;
            try {
                Class<?> iAppThread = cachedClassForName("android.app.IApplicationThread");
                if (iAppThread == null) throw new ClassNotFoundException("IApplicationThread");
                moveToFront = findMethod(clazz, "moveTaskToFront",
                        iAppThread, String.class, int.class, int.class, android.os.Bundle.class);
                if (moveToFront == null) {
                    moveToFront = findMethod(clazz, "moveTaskToFront",
                            iAppThread, String.class, int.class, android.os.Bundle.class);
                }
            } catch (ClassNotFoundException ignored) {}
            // Fallback: search by name only
            if (moveToFront == null) {
                for (Method m : clazz.getDeclaredMethods()) {
                    if ("moveTaskToFront".equals(m.getName())) { moveToFront = m; break; }
                }
            }
            if (moveToFront != null) {
                hook(moveToFront)
                        .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                        .intercept(chain -> {
                            Object result = chain.proceed();
                            // Foreground changed — trigger immediate snapshot
                            foregroundRecentlyChanged = true;
                            try { broadcastSnapshot(); } catch (Throwable ignored) {}
                            return result;
                        });
                log(Log.INFO, TAG, "hooked ActivityTaskManagerService#moveTaskToFront (event-driven)");
            }
        } catch (Throwable t) {
            log(Log.WARN, TAG, "foreground sampler hook skipped: " + t.getClass().getSimpleName());
            startForegroundSampler();
        }
    }

    private void installInputMethodHooks(ClassLoader cl) {
        try {
            Class<?> clazz = cachedClassForName("com.android.server.inputmethod.InputMethodManagerService", cl);
            if (clazz == null) throw new ClassNotFoundException("InputMethodManagerService");
            int hooked = 0;
            for (Method method : clazz.getDeclaredMethods()) {
                String name = method.getName();
                if (name == null) continue;
                boolean marksActive = name.contains("showSoftInput") ||
                        name.contains("showCurrentInput") ||
                        name.contains("startInputOrWindowGainedFocus");
                boolean marksInactive = name.contains("hideSoftInput") ||
                        name.contains("hideCurrentInput");
                if (!marksActive && !marksInactive) continue;
                hook(method)
                        .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                        .intercept(chain -> {
                            Object result = chain.proceed();
                            boolean nextActive = marksActive && !marksInactive;
                            if (name.contains("startInputOrWindowGainedFocus")) {
                                nextActive = hasTextEditorInfo(chain.getArgs());
                            }
                            if (inputActive != nextActive) {
                                inputActive = nextActive;
                                try { maybeDirectUpload(true); } catch (Throwable ignored) {}
                                try { broadcastSnapshot(); } catch (Throwable ignored) {}
                            }
                            return result;
                        });
                hooked++;
            }
            log(Log.INFO, TAG, "hooked InputMethodManagerService methods: " + hooked);
        } catch (Throwable t) {
            log(Log.WARN, TAG, "input method hooks skipped: " + t.getClass().getSimpleName());
        }
    }

    private boolean hasTextEditorInfo(List<Object> args) {
        try {
            boolean sawEditorInfo = false;
            for (Object arg : args) {
                if (arg instanceof EditorInfo) {
                    sawEditorInfo = true;
                    int inputType = ((EditorInfo) arg).inputType;
                    if (inputType != InputType.TYPE_NULL) return true;
                }
            }
            return !sawEditorInfo;
        } catch (Throwable ignored) {
            return true;
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
                try { registerScreenStateReceiver(handler); } catch (Throwable t) { log(Log.WARN, TAG, "deferred register screen receiver failed: " + t.getClass().getSimpleName()); }
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
                        // Low-frequency fallback only; foreground/media/input hooks drive normal updates.
                        handler.postDelayed(this, HEARTBEAT_MS);
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
        if (uploadThread != null && uploadHandler != null && uploadThread.isAlive()) return;
        try {
            uploadThread = new HandlerThread("MonikaLspUpload", android.os.Process.THREAD_PRIORITY_BACKGROUND);
            uploadThread.start();
            uploadHandler = new Handler(uploadThread.getLooper());
            log(Log.INFO, TAG, "upload HandlerThread started");
        } catch (Throwable t) {
            log(Log.WARN, TAG, "init upload thread failed: " + t.getClass().getSimpleName());
        }
    }

    private void registerScreenStateReceiver(Handler handler) {
        if (screenReceiverRegistered) return;
        Context context = getSystemContext();
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
                            try { broadcastSnapshot(); } catch (Throwable ignored) {}
                        });
                    } else if (Intent.ACTION_SCREEN_ON.equals(action)) {
                        lastForegroundKey = "";
                        lastScreenOffCheckAt = 0L;
                        foregroundRecentlyChanged = true;
                        handler.postDelayed(() -> {
                            try { broadcastSnapshot(); } catch (Throwable ignored) {}
                        }, 500L);
                    }
                }
            };
            // Screen broadcasts are system-originated; exporting the dynamic receiver
            // preserves delivery on Android 13+ while the action filter stays narrow.
            if (android.os.Build.VERSION.SDK_INT >= 34) {
                context.registerReceiver(receiver, filter, null, handler, Context.RECEIVER_EXPORTED);
            } else if (android.os.Build.VERSION.SDK_INT >= 33) {
                context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
            } else {
                context.registerReceiver(receiver, filter, null, handler);
            }
            screenReceiverRegistered = true;
            log(Log.INFO, TAG, "registered screen state receiver");
        } catch (Throwable t) {
            log(Log.WARN, TAG, "screen receiver failed: " + t.getClass().getSimpleName());
        }
    }

    private Handler getUploadHandler() {
        if (uploadHandler != null) return uploadHandler;
        synchronized (this) {
            if (uploadHandler == null) initUploadThread();
        }
        if (uploadHandler != null) return uploadHandler;
        return null;
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

                    // Verify the claimed package is (or recently was) the foreground browser.
                    // Use time-window cache (2s) to tolerate broadcast delay — avoids
                    // losing titles when user switches away just as broadcast arrives.
                    ComponentName top = getTopActivityComponentName();
                    boolean isCurrentForeground = top != null && pkg.equals(top.getPackageName());
                    boolean wasRecentForeground = pkg.equals(recentForegroundBrowser)
                            && System.currentTimeMillis() - recentForegroundBrowserAt < 2000L;
                    if (!isCurrentForeground && !wasRecentForeground) {
                        log(Log.DEBUG, TAG, "browser title ignored: " + pkg + " is not foreground");
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
                            refreshMediaFromControllers(controllers);
                            // Cleanup: remove stale entries from registeredMediaControllers
                            // that are no longer in the active session list
                            java.util.Set<String> activeKeys = new java.util.HashSet<>();
                            for (MediaController c : controllers) {
                                activeKeys.add(c.getPackageName() + "@" + System.identityHashCode(c));
                            }
                            synchronized (registeredMediaControllers) {
                                registeredMediaControllers.retainAll(activeKeys);
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
        String key = controller.getPackageName() + "@" + System.identityHashCode(controller);
        synchronized (registeredMediaControllers) {
            if (registeredMediaControllers.contains(key)) return;
            registeredMediaControllers.add(key);
        }
        try {
            controller.registerCallback(new MediaController.Callback() {
                @Override
                public void onPlaybackStateChanged(PlaybackState state) {
                    try {
                        if (state == null) return;
                        String pkg = controller.getPackageName();
                        boolean nextPlaying = state.getState() == PlaybackState.STATE_PLAYING;
                        mediaPlaying = nextPlaying;
                        mediaPackage = safeString(pkg);
                        mediaApp = safeString(resolveAppLabel(pkg));
                        mediaState = safeString(playbackStateName(state));
                        MediaMetadata metadata = controller.getMetadata();
                        if (nextPlaying && metadata != null) {
                            mediaTitle = safeString(firstNonBlank(
                                    mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_DISPLAY_TITLE),
                                    mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_TITLE)));
                            mediaArtist = safeString(firstNonBlank(
                                    mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_ARTIST),
                                    mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_AUTHOR),
                                    mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_ALBUM_ARTIST)));
                        } else if (!nextPlaying) {
                            mediaTitle = "";
                            mediaArtist = "";
                        }
                        log(Log.DEBUG, TAG, "media playback: pkg=" + pkg + " playing=" + mediaPlaying + " title=" + mediaTitle);
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
                        log(Log.DEBUG, TAG, "media metadata: pkg=" + pkg + " title=" + mediaTitle + " artist=" + mediaArtist);
                        maybeDirectUpload(false);
                    } catch (Throwable t) {
                        log(Log.WARN, TAG, "onMetadataChanged failed: " + t.getClass().getSimpleName());
                    }
                }
            });
        } catch (Throwable ignored) {
            synchronized (registeredMediaControllers) {
                registeredMediaControllers.remove(key);
            }
        }
    }

    private void refreshMediaFromControllers(List<MediaController> controllers) {
        try {
            MediaController playing = null;
            if (controllers != null) {
                for (MediaController controller : controllers) {
                    PlaybackState state = controller.getPlaybackState();
                    if (state != null && state.getState() == PlaybackState.STATE_PLAYING) {
                        playing = controller;
                        break;
                    }
                }
            }
            if (playing == null) {
                mediaPlaying = false;
                mediaTitle = "";
                mediaArtist = "";
                mediaState = "paused";
                return;
            }
            String pkg = playing.getPackageName();
            mediaPlaying = true;
            mediaPackage = safeString(pkg);
            mediaApp = safeString(resolveAppLabel(pkg));
            PlaybackState state = playing.getPlaybackState();
            mediaState = safeString(playbackStateName(state));
            MediaMetadata metadata = playing.getMetadata();
            if (metadata != null) {
                mediaTitle = safeString(firstNonBlank(
                        mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_DISPLAY_TITLE),
                        mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_TITLE)));
                mediaArtist = safeString(firstNonBlank(
                        mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_ARTIST),
                        mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_AUTHOR),
                        mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_ALBUM_ARTIST)));
            }
        } catch (Throwable t) {
            log(Log.DEBUG, TAG, "refresh media failed: " + t.getClass().getSimpleName());
        }
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
        String cacheKey = clazz.getName() + "#" + name + NO_ARG_SIG;
        Object cached = methodLookupCache.get(cacheKey);
        if (cached instanceof Method) return (Method) cached;
        if (cached == REFLECTION_MISS) return null;
        for (Method method : clazz.getDeclaredMethods()) {
            if (name.equals(method.getName())) {
                try { method.setAccessible(true); } catch (Throwable ignored) {}
                methodLookupCache.put(cacheKey, method);
                return method;
            }
        }
        methodLookupCache.put(cacheKey, REFLECTION_MISS);
        return null;
    }

    private Method findMethod(Class<?> clazz, String name, Class<?>... paramTypes) {
        String cacheKey = clazz.getName() + "#" + name + signatureOf(paramTypes);
        Object cached = methodLookupCache.get(cacheKey);
        if (cached instanceof Method) return (Method) cached;
        if (cached == REFLECTION_MISS) return null;
        try {
            Method method = clazz.getDeclaredMethod(name, paramTypes);
            try { method.setAccessible(true); } catch (Throwable ignored) {}
            methodLookupCache.put(cacheKey, method);
            return method;
        } catch (NoSuchMethodException ignored) {
            methodLookupCache.put(cacheKey, REFLECTION_MISS);
            return null;
        }
    }

    private Method findPublicMethod(Class<?> clazz, String name, Class<?>... paramTypes) {
        String cacheKey = clazz.getName() + "#public:" + name + signatureOf(paramTypes);
        Object cached = methodLookupCache.get(cacheKey);
        if (cached instanceof Method) return (Method) cached;
        if (cached == REFLECTION_MISS) return null;
        try {
            Method method = clazz.getMethod(name, paramTypes);
            try { method.setAccessible(true); } catch (Throwable ignored) {}
            methodLookupCache.put(cacheKey, method);
            return method;
        } catch (Throwable ignored) {
            methodLookupCache.put(cacheKey, REFLECTION_MISS);
            return null;
        }
    }

    private String signatureOf(Class<?>... paramTypes) {
        if (paramTypes == null || paramTypes.length == 0) return NO_ARG_SIG;
        StringBuilder sb = new StringBuilder();
        for (Class<?> param : paramTypes) {
            if (sb.length() > 0) sb.append(',');
            sb.append(param != null ? param.getName() : "null");
        }
        return sb.toString();
    }

    private Class<?> cachedClassForName(String name) {
        return cachedClassForName(name, null);
    }

    private Class<?> cachedClassForName(String name, ClassLoader loader) {
        String cacheKey = name + "@" + (loader != null ? System.identityHashCode(loader) : 0);
        Object cached = classCache.get(cacheKey);
        if (cached instanceof Class<?>) return (Class<?>) cached;
        if (cached == REFLECTION_MISS) return null;
        try {
            Class<?> clazz = loader != null ? Class.forName(name, false, loader) : Class.forName(name);
            classCache.put(cacheKey, clazz);
            return clazz;
        } catch (Throwable ignored) {
            classCache.put(cacheKey, REFLECTION_MISS);
            return null;
        }
    }

    private void installActivityTitleHooks(ClassLoader cl, String packageName) {
        try {
            Class<?> activity = cachedClassForName("android.app.Activity", cl);
            if (activity == null) return;

            // Hook 1: Activity#setTitle(CharSequence)
            Method setTitleText = findMethod(activity, "setTitle", CharSequence.class);
            if (setTitleText == null) return;
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
            Method setTitleRes = findMethod(activity, "setTitle", int.class);
            if (setTitleRes == null) return;
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
            Class<?> taskDescription = cachedClassForName("android.app.ActivityManager$TaskDescription", cl);
            if (taskDescription == null) return;
            Method setTaskDesc = findMethod(activity, "setTaskDescription", taskDescription);
            if (setTaskDesc == null) return;
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
                                Method getLabel = findPublicMethod(td.getClass(), "getLabel");
                                Object label = getLabel != null ? getLabel.invoke(td) : null;
                                if (label instanceof CharSequence && ((CharSequence) label).length() > 0) {
                                    publishBrowserTitle((Activity) owner, packageName, label.toString());
                                }
                            }
                        } catch (Throwable ignored) {}
                        return result;
                    });

            // Hook 4: Activity#onWindowFocusChanged
            Method focusChanged = findMethod(activity, "onWindowFocusChanged", boolean.class);
            if (focusChanged == null) return;
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
                Class<?> window = cachedClassForName("android.view.Window", cl);
                if (window == null) throw new ClassNotFoundException("android.view.Window");
                Method windowSetTitle = findMethod(window, "setTitle", CharSequence.class);
                if (windowSetTitle == null) throw new NoSuchMethodException("Window#setTitle");
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
                                    Method getContext = findPublicMethod(windowObj.getClass(), "getContext");
                                    Object ctx = getContext != null ? getContext.invoke(windowObj) : null;
                                    Activity activityCtx = findActivityContext(ctx);
                                    if (activityCtx != null) {
                                        publishBrowserTitle(activityCtx, packageName, title);
                                    }
                                }
                            } catch (Throwable ignored) {}
                            return result;
                        });
            } catch (Throwable ignored) {}

            // Hook 6: WebChromeClient#onReceivedTitle
            try {
                Class<?> wcc = cachedClassForName("android.webkit.WebChromeClient", cl);
                Class<?> webViewClass = cachedClassForName("android.webkit.WebView", cl);
                if (wcc == null || webViewClass == null) throw new ClassNotFoundException("android.webkit");
                Method onReceivedTitle = findMethod(wcc, "onReceivedTitle", webViewClass, String.class);
                if (onReceivedTitle == null) throw new NoSuchMethodException("WebChromeClient#onReceivedTitle");
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
                                    Method getContext = findPublicMethod(webView.getClass(), "getContext");
                                    Object ctx = getContext != null ? getContext.invoke(webView) : null;
                                    Activity activityCtx = findActivityContext(ctx);
                                    if (activityCtx != null) {
                                        publishBrowserTitle(activityCtx, packageName, title);
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

            installWebViewTitleHooks(cl, packageName);
            installAospBrowserTitleHooks(cl, packageName);

            log(Log.INFO, TAG, "installed browser title hooks for " + packageName);
        } catch (Throwable t) {
            log(Log.WARN, TAG, "activity title hook failed for " + packageName + ": " + t.getClass().getSimpleName());
        }
    }

    private void installWebViewTitleHooks(ClassLoader cl, String packageName) {
        try {
            Class<?> webView = cachedClassForName("android.webkit.WebView", cl);
            if (webView == null) throw new ClassNotFoundException("android.webkit.WebView");
            hookWebViewNavigation(webView, packageName, "loadUrl", String.class);
            hookWebViewNavigation(webView, packageName, "loadUrl", String.class, java.util.Map.class);
            hookWebViewNavigation(webView, packageName, "postUrl", String.class, byte[].class);
            hookWebViewNavigation(webView, packageName, "reload");
            hookWebViewNavigation(webView, packageName, "goBack");
            hookWebViewNavigation(webView, packageName, "goForward");
            hookWebChromeTitle(cl, webView, packageName);
            hookWebViewClientPageFinished(cl, webView, packageName);
            hookWebViewClientInstallers(webView, packageName);
        } catch (Throwable ignored) {}
    }

    private void hookWebChromeTitle(ClassLoader cl, Class<?> webView, String packageName) {
        try {
            Class<?> chromeClient = cachedClassForName("android.webkit.WebChromeClient", cl);
            if (chromeClient == null) throw new ClassNotFoundException("android.webkit.WebChromeClient");
            Method method = findMethod(chromeClient, "onReceivedTitle", webView, String.class);
            if (method == null) return;
            try { deoptimize(method); } catch (Throwable ignored) {}
            hook(method)
                    .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                    .intercept(chain -> {
                        Object result = chain.proceed();
                        try {
                            List<Object> args = chain.getArgs();
                            if (args.size() > 1 && args.get(1) instanceof String) {
                                publishTitleFromWebView(args.get(0), packageName, (String) args.get(1));
                            }
                        } catch (Throwable ignored) {}
                        return result;
                    });
            log(Log.INFO, TAG, "hooked WebChromeClient#onReceivedTitle for " + packageName);
        } catch (Throwable ignored) {}
    }

    private void hookWebViewClientInstallers(Class<?> webView, String packageName) {
        try {
            Class<?> chromeClient = cachedClassForName("android.webkit.WebChromeClient", webView.getClassLoader());
            if (chromeClient == null) throw new ClassNotFoundException("android.webkit.WebChromeClient");
            Method setChromeClient = findMethod(webView, "setWebChromeClient", chromeClient);
            if (setChromeClient != null) {
                try { deoptimize(setChromeClient); } catch (Throwable ignored) {}
                hook(setChromeClient)
                        .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                        .intercept(chain -> {
                            Object result = chain.proceed();
                            try {
                                List<Object> args = chain.getArgs();
                                if (args.size() > 0 && args.get(0) != null) {
                                    hookSpecificWebChromeClient(args.get(0).getClass(), webView, packageName);
                                }
                            } catch (Throwable ignored) {}
                            return result;
                        });
                log(Log.INFO, TAG, "hooked WebView#setWebChromeClient for " + packageName);
            }
        } catch (Throwable ignored) {}

        try {
            Class<?> viewClient = cachedClassForName("android.webkit.WebViewClient", webView.getClassLoader());
            if (viewClient == null) throw new ClassNotFoundException("android.webkit.WebViewClient");
            Method setViewClient = findMethod(webView, "setWebViewClient", viewClient);
            if (setViewClient != null) {
                try { deoptimize(setViewClient); } catch (Throwable ignored) {}
                hook(setViewClient)
                        .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                        .intercept(chain -> {
                            Object result = chain.proceed();
                            try {
                                List<Object> args = chain.getArgs();
                                if (args.size() > 0 && args.get(0) != null) {
                                    hookSpecificWebViewClient(args.get(0).getClass(), webView, packageName);
                                }
                            } catch (Throwable ignored) {}
                            return result;
                        });
                log(Log.INFO, TAG, "hooked WebView#setWebViewClient for " + packageName);
            }
        } catch (Throwable ignored) {}
    }

    private void hookSpecificWebChromeClient(Class<?> clientClass, Class<?> webView, String packageName) {
        if (clientClass == null) return;
        String className = clientClass.getName();
        if (!hookedWebChromeClientClasses.add(packageName + ":" + className)) return;
        Method method = findMethod(clientClass, "onReceivedTitle", webView, String.class);
        if (method == null) return;
        try { method.setAccessible(true); } catch (Throwable ignored) {}
        try { deoptimize(method); } catch (Throwable ignored) {}
        try {
            hook(method)
                    .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                    .intercept(chain -> {
                        Object result = chain.proceed();
                        try {
                            List<Object> args = chain.getArgs();
                            if (args.size() > 1 && args.get(1) instanceof String) {
                                publishTitleFromWebView(args.get(0), packageName, (String) args.get(1));
                            }
                        } catch (Throwable ignored) {}
                        return result;
                    });
            log(Log.INFO, TAG, "hooked concrete WebChromeClient#onReceivedTitle: " + className);
        } catch (Throwable ignored) {}
    }

    private void hookSpecificWebViewClient(Class<?> clientClass, Class<?> webView, String packageName) {
        if (clientClass == null) return;
        String className = clientClass.getName();
        if (!hookedWebViewClientClasses.add(packageName + ":" + className)) return;
        Method method = findMethod(clientClass, "onPageFinished", webView, String.class);
        if (method == null) return;
        try { method.setAccessible(true); } catch (Throwable ignored) {}
        try { deoptimize(method); } catch (Throwable ignored) {}
        try {
            hook(method)
                    .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                    .intercept(chain -> {
                        Object result = chain.proceed();
                        try {
                            List<Object> args = chain.getArgs();
                            if (args.size() > 0) {
                                scheduleWebViewTitleRead(args.get(0), packageName, 150L);
                                scheduleWebViewTitleRead(args.get(0), packageName, 900L);
                            }
                        } catch (Throwable ignored) {}
                        return result;
                    });
            log(Log.INFO, TAG, "hooked concrete WebViewClient#onPageFinished: " + className);
        } catch (Throwable ignored) {}
    }

    private void hookWebViewClientPageFinished(ClassLoader cl, Class<?> webView, String packageName) {
        try {
            Class<?> viewClient = cachedClassForName("android.webkit.WebViewClient", cl);
            if (viewClient == null) throw new ClassNotFoundException("android.webkit.WebViewClient");
            Method method = findMethod(viewClient, "onPageFinished", webView, String.class);
            if (method == null) return;
            try { deoptimize(method); } catch (Throwable ignored) {}
            hook(method)
                    .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                    .intercept(chain -> {
                        Object result = chain.proceed();
                        try {
                            List<Object> args = chain.getArgs();
                            if (args.size() > 0) {
                                scheduleWebViewTitleRead(args.get(0), packageName, 150L);
                                scheduleWebViewTitleRead(args.get(0), packageName, 900L);
                            }
                        } catch (Throwable ignored) {}
                        return result;
                    });
            log(Log.INFO, TAG, "hooked WebViewClient#onPageFinished for " + packageName);
        } catch (Throwable ignored) {}
    }

    private void installAospBrowserTitleHooks(ClassLoader cl, String packageName) {
        if (!"com.android.browser".equals(packageName)) return;
        try {
            Class<?> browserActivity = cachedClassForName("com.android.browser.BrowserActivity", cl);
            if (browserActivity == null) throw new ClassNotFoundException("com.android.browser.BrowserActivity");
            for (Method method : browserActivity.getDeclaredMethods()) {
                if (!"setUrlTitle".equals(method.getName())) continue;
                Class<?>[] params = method.getParameterTypes();
                if (params.length != 2 || params[0] != String.class || params[1] != String.class) continue;
                try { method.setAccessible(true); } catch (Throwable ignored) {}
                try { deoptimize(method); } catch (Throwable ignored) {}
                hook(method)
                        .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                        .intercept(chain -> {
                            Object result = chain.proceed();
                            try {
                                Object owner = chain.getThisObject();
                                List<Object> args = chain.getArgs();
                                if (owner instanceof Activity && args.size() > 1 && args.get(1) instanceof String) {
                                    publishBrowserTitle((Activity) owner, packageName, (String) args.get(1));
                                }
                            } catch (Throwable ignored) {}
                            return result;
                        });
                log(Log.INFO, TAG, "hooked AOSP BrowserActivity#setUrlTitle");
            }

            Class<?> webView = cachedClassForName("android.webkit.WebView", cl);
            if (webView == null) throw new ClassNotFoundException("android.webkit.WebView");
            hookAospBrowserPageCallback(browserActivity, packageName, "onPageFinished", webView, String.class);
        } catch (Throwable t) {
            log(Log.DEBUG, TAG, "AOSP browser title hooks skipped: " + t.getClass().getSimpleName());
        }
    }

    private void hookAospBrowserPageCallback(Class<?> browserActivity, String packageName, String methodName, Class<?>... paramTypes) {
        Method method = findMethod(browserActivity, methodName, paramTypes);
        if (method == null) return;
        try { method.setAccessible(true); } catch (Throwable ignored) {}
        try { deoptimize(method); } catch (Throwable ignored) {}
        try {
            hook(method)
                    .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                    .intercept(chain -> {
                        Object result = chain.proceed();
                        try {
                            List<Object> args = chain.getArgs();
                            if (args.size() > 0) {
                                scheduleWebViewTitleRead(args.get(0), packageName, 150L);
                                scheduleWebViewTitleRead(args.get(0), packageName, 900L);
                            }
                        } catch (Throwable ignored) {}
                        return result;
                    });
            log(Log.INFO, TAG, "hooked AOSP BrowserActivity#" + methodName);
        } catch (Throwable ignored) {}
    }

    private void hookWebViewNavigation(Class<?> webView, String packageName, String methodName, Class<?>... paramTypes) {
        Method method = findMethod(webView, methodName, paramTypes);
        if (method == null) return;
        try { deoptimize(method); } catch (Throwable ignored) {}
        try {
            hook(method)
                    .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                    .intercept(chain -> {
                        Object result = chain.proceed();
                        Object owner = chain.getThisObject();
                        scheduleWebViewTitleRead(owner, packageName, 900L);
                        scheduleWebViewTitleRead(owner, packageName, 2500L);
                        return result;
                    });
        } catch (Throwable ignored) {}
    }

    private void scheduleWebViewTitleRead(Object webView, String packageName, long delayMs) {
        if (webView == null) return;
        try {
            Method postDelayed = findPublicMethod(webView.getClass(), "postDelayed", Runnable.class, long.class);
            if (postDelayed == null) return;
            postDelayed.invoke(webView, (Runnable) () -> publishTitleFromWebView(webView, packageName), delayMs);
        } catch (Throwable ignored) {}
    }

    private void publishTitleFromWebView(Object webView, String packageName) {
        publishTitleFromWebView(webView, packageName, "");
    }

    private void publishTitleFromWebView(Object webView, String packageName, String explicitTitle) {
        try {
            Object rawTitle = explicitTitle != null && explicitTitle.trim().length() > 0 ? explicitTitle : null;
            if (rawTitle == null) {
                Method getTitle = findPublicMethod(webView.getClass(), "getTitle");
                if (getTitle == null) return;
                rawTitle = getTitle.invoke(webView);
            }
            if (!(rawTitle instanceof String)) return;
            String title = (String) rawTitle;
            Method getContext = findPublicMethod(webView.getClass(), "getContext");
            if (getContext == null) return;
            Object ctx = getContext.invoke(webView);
            Activity activityCtx = findActivityContext(ctx);
            if (activityCtx != null) {
                publishBrowserTitle(activityCtx, packageName, title);
            } else {
                publishBrowserTitleFromProcess(ctx instanceof Context ? (Context) ctx : null, packageName, title, "");
            }
        } catch (Throwable ignored) {}
    }

    private Activity findActivityContext(Object value) {
        try {
            Object current = value;
            int depth = 0;
            while (current instanceof ContextWrapper && depth < 8) {
                if (current instanceof Activity) return (Activity) current;
                current = ((ContextWrapper) current).getBaseContext();
                depth++;
            }
            return current instanceof Activity ? (Activity) current : null;
        } catch (Throwable ignored) {
            return null;
        }
    }

    private void publishBrowserTitle(Activity activity, String packageName, String title) {
        try {
            String clean = cleanTitle(title);
            if (clean == null || isIgnoredPackage(packageName)) return;
            // Debounce: skip if same title or within 1 second
            long now = System.currentTimeMillis();
            if (clean.equals(lastBroadcastTitle) && now - lastTitleBroadcastAt < 1000L) return;
            lastBroadcastTitle = clean;
            lastTitleBroadcastAt = now;
            // NOTE: Do NOT set foreground* fields here in browser process!
            // Browser process has its own copy of static fields (different process).
            // Only system_server should update these via the broadcast receiver.
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
            long now = System.currentTimeMillis();
            boolean forceDirectUpload = false;

            // ── Screen-off / sleep detection ──
            // When the screen is off, skip ATMS calls entirely and report sleeping.
            // This prevents stale "last foreground app" from being reported during sleep,
            // and avoids unnecessary hidden-API calls that may fail during deep sleep.
            boolean screenOn = isScreenInteractive();
            if (!screenOn) {
                if (now - lastScreenOffCheckAt < SCREEN_OFF_DEBOUNCE_MS) return;
                lastScreenOffCheckAt = now;
                // Only report sleeping if not already in that state
                if ("sleeping".equals(lastForegroundKey) && now - lastForegroundBroadcastAt < BROADCAST_DEBOUNCE_MS) return;
                lastForegroundKey = "sleeping";
                lastForegroundBroadcastAt = now;
                idleConsecutiveCount = 0;
                foregroundPackage = "sleeping";
                foregroundApp = "sleeping";
                foregroundActivity = "";
                foregroundTitle = "";
                log(Log.INFO, TAG, "screen off → sleeping");
                forceDirectUpload = true;
                Intent sleepIntent = new Intent(ACTION_STATUS);
                sleepIntent.setComponent(new ComponentName(TARGET_PACKAGE, TARGET_RECEIVER));
                sleepIntent.putExtra("package_name", "sleeping");
                sleepIntent.putExtra("app_name", "sleeping");
                sleepIntent.putExtra("activity", "");
                sleepIntent.putExtra("input_active", false);
                inputActive = false;
                Context ctx = getSystemContext();
                if (ctx != null) {
                    long token = Binder.clearCallingIdentity();
                    try { ctx.sendBroadcast(sleepIntent); } finally { Binder.restoreCallingIdentity(token); }
                }
                maybeDirectUpload(forceDirectUpload);
                return;
            }
            // Reset sleep state when screen comes back on
            if ("sleeping".equals(lastForegroundKey)) {
                lastForegroundKey = ""; // force foreground detection on wake
                log(Log.INFO, TAG, "screen on → waking from sleep");
            }

            ComponentName top = getTopActivityComponentName();
            boolean idleCandidate = top == null || isIgnoredPackage(top.getPackageName());

            // Only call expensive getFocusedTaskDescription when foreground changed or is browser
            String taskDescription = null;
            if (!idleCandidate) {
                String pkg = top.getPackageName();
                String newKey = pkg + "/" + top.getClassName();
                boolean foregroundChanged = !newKey.equals(lastForegroundKey);
                boolean isBrowser = isBrowserPackage(pkg);
                if (foregroundChanged || isBrowser) {
                    taskDescription = getFocusedTaskDescription();
                }
            }

            if (idleCandidate) {
                // Debounce: only report idle after N consecutive idle samples.
                // Avoids noise from momentary launcher flashes / hidden API gaps / split-focus glitches.
                idleConsecutiveCount++;
                if (idleConsecutiveCount < IDLE_DEBOUNCE_COUNT) return; // skip — wait for more samples
                // N consecutive idles reached → commit idle state
                if ("idle".equals(lastForegroundKey) && now - lastForegroundBroadcastAt < BROADCAST_DEBOUNCE_MS) return;
                forceDirectUpload = !"idle".equals(lastForegroundKey);
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
                    foregroundRecentlyChanged = true;
                    forceDirectUpload = true;
                } else {
                    foregroundRecentlyChanged = false;
                }
                if (key.equals(lastForegroundKey) && now - lastForegroundBroadcastAt < BROADCAST_DEBOUNCE_MS) return;
                lastForegroundKey = key;
                lastForegroundBroadcastAt = now;
                foregroundPackage = packageName;
                foregroundApp = safeString(resolveAppLabel(packageName));
                // Cache recent foreground browser for race-condition tolerance
                if (isBrowserPackage(packageName)) {
                    recentForegroundBrowser = packageName;
                    recentForegroundBrowserAt = now;
                }
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
                intent.putExtra("input_active", inputActive);
            } else {
                intent.putExtra("package_name", foregroundPackage);
                intent.putExtra("app_name", foregroundApp);
                intent.putExtra("activity", foregroundActivity);
                intent.putExtra("input_active", inputActive);
                if (foregroundTitle.length() > 0) {
                    intent.putExtra("title", foregroundTitle);
                }
            }
            Context context = getSystemContext();
            if (context != null) {
                long token = Binder.clearCallingIdentity();
                try { context.sendBroadcast(intent); } finally { Binder.restoreCallingIdentity(token); }
            }
            maybeDirectUpload(forceDirectUpload);
        } catch (Throwable t) {
            log(Log.WARN, TAG, "broadcast failed: " + t.getClass().getSimpleName());
        }
    }

    private ComponentName getTopActivityComponentName() {
        try {
            Object service = getActivityTaskManagerService();
            if (service == null) return getRecentTopActivityFallback();
            Object info = callAny(service, "getFocusedRootTaskInfo");
            if (info == null) info = callAny(service, "getFocusedStackInfo");
            ComponentName top = componentFromTaskInfo(info);
            if (top == null) top = getTopActivityFromTasks(service);
            if (top != null) {
                lastKnownTopComponent = top;
                lastKnownTopAt = System.currentTimeMillis();
                return top;
            }
            return getRecentTopActivityFallback();
        } catch (Throwable ignored) {
            return getRecentTopActivityFallback();
        }
    }

    private ComponentName componentFromTaskInfo(Object info) {
        if (info == null) return null;
        String[] fields = new String[] {
                "topActivity",
                "topActivityInfo",
                "topRunningActivity",
                "resumedActivity",
                "mResumedActivity",
                "realActivity",
                "baseActivity",
                "origActivity"
        };
        for (String field : fields) {
            Object value = readField(info, field);
            if (value instanceof ComponentName) return (ComponentName) value;
            if (value instanceof ActivityInfo) {
                ActivityInfo activityInfo = (ActivityInfo) value;
                if (activityInfo.packageName != null && activityInfo.name != null) {
                    return new ComponentName(activityInfo.packageName, activityInfo.name);
                }
            }
        }
        return null;
    }

    private ComponentName getTopActivityFromTasks(Object service) {
        try {
            Method method = findCompatibleGetTasksMethod(service.getClass());
            if (method == null) return null;
            method.setAccessible(true);
            Object[] args = buildDefaultArgs(method.getParameterTypes(), 3);
            @SuppressWarnings("unchecked")
            List<?> tasks = (List<?>) method.invoke(service, args);
            if (tasks == null || tasks.isEmpty()) return null;
            for (Object task : tasks) {
                ComponentName top = componentFromTaskInfo(task);
                if (top == null) {
                    Object taskInfo = readField(task, "taskInfo");
                    top = componentFromTaskInfo(taskInfo);
                }
                if (top != null && !isIgnoredPackage(top.getPackageName())) return top;
            }
        } catch (Throwable t) {
            log(Log.DEBUG, TAG, "getTasks top fallback failed: " + t.getClass().getSimpleName());
        }
        return null;
    }

    private Method findCompatibleGetTasksMethod(Class<?> clazz) {
        String cacheKey = clazz.getName() + "#compatibleGetTasks";
        Object cached = methodLookupCache.get(cacheKey);
        if (cached instanceof Method) return (Method) cached;
        if (cached == REFLECTION_MISS) return null;
        for (Method method : clazz.getDeclaredMethods()) {
            if (!"getTasks".equals(method.getName())) continue;
            Class<?>[] params = method.getParameterTypes();
            if (params.length == 0 || params[0] != int.class) continue;
            try { method.setAccessible(true); } catch (Throwable ignored) {}
            methodLookupCache.put(cacheKey, method);
            return method;
        }
        methodLookupCache.put(cacheKey, REFLECTION_MISS);
        return null;
    }

    private Object[] buildDefaultArgs(Class<?>[] params, int maxTasks) {
        Object[] args = new Object[params.length];
        for (int i = 0; i < params.length; i++) {
            Class<?> type = params[i];
            if (i == 0 && type == int.class) {
                args[i] = maxTasks;
            } else if (type == boolean.class) {
                args[i] = false;
            } else if (type == int.class) {
                args[i] = 0;
            } else if (type == long.class) {
                args[i] = 0L;
            } else if (type == float.class) {
                args[i] = 0f;
            } else if (type == double.class) {
                args[i] = 0d;
            } else if (type == String.class) {
                args[i] = TARGET_PACKAGE;
            } else if (type.isArray()) {
                args[i] = java.lang.reflect.Array.newInstance(type.getComponentType(), 0);
            } else if (java.util.List.class.isAssignableFrom(type)) {
                args[i] = java.util.Collections.emptyList();
            } else {
                args[i] = null;
            }
        }
        return args;
    }

    private ComponentName getRecentTopActivityFallback() {
        ComponentName cached = lastKnownTopComponent;
        if (cached == null) return null;
        long age = System.currentTimeMillis() - lastKnownTopAt;
        if (age >= 0 && age <= TOP_ACTIVITY_FALLBACK_MS) return cached;
        return null;
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
                    Method getTasks = findCompatibleGetTasksMethod(service.getClass());
                    if (getTasks == null) return null;
                    @SuppressWarnings("unchecked")
                    List<?> tasks = (List<?>) getTasks.invoke(service, buildDefaultArgs(getTasks.getParameterTypes(), 1));
                    if (tasks != null && !tasks.isEmpty()) {
                        Object topTask = tasks.get(0);
                        // Try to get TaskInfo from RunningTaskInfo
                        info = readField(topTask, "taskInfo");
                        if (info == null) info = topTask;
                    }
                } catch (Throwable t) {
                    log(Log.DEBUG, TAG, "getTasks fallback skipped: " + t.getClass().getSimpleName());
                }
            }
            
            if (info == null) return null;
            
            // Try multiple field names for TaskDescription
            Object desc = readField(info, "taskDescription");
            if (desc == null) desc = readField(info, "description");
            if (desc == null) desc = readField(info, "origDescription");
            
            if (desc == null) return null;
            
            // desc might be an ActivityManager.TaskDescription object instead of CharSequence
            if (desc != null && !(desc instanceof CharSequence)) {
                try {
                    // Try getLabel() method (standard API)
                    Method getLabel = findPublicMethod(desc.getClass(), "getLabel");
                    if (getLabel == null) return null;
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
            log(Log.DEBUG, TAG, "getFocusedTaskDescription skipped: " + t.getClass().getSimpleName());
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
            Class<?> miuiBuild = cachedClassForName("miui.os.Build");
            Object isTablet = miuiBuild != null ? readStaticField(miuiBuild, "IS_TABLET") : null;
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

    private volatile Object cachedAtmService = null;
    private volatile Context cachedSystemContext = null;

    private Object getActivityTaskManagerService() {
        Object cached = cachedAtmService;
        if (cached != null) return cached;
        try {
            Class<?> atm = cachedClassForName("android.app.ActivityTaskManager");
            Method getService = atm != null ? findMethod(atm, "getService") : null;
            Object service = getService != null ? getService.invoke(null) : null;
            if (service != null) { cachedAtmService = service; return service; }
        } catch (Throwable ignored) {
        }
        try {
            Class<?> serviceManager = cachedClassForName("android.os.ServiceManager");
            Method getService = serviceManager != null ? findMethod(serviceManager, "getService", String.class) : null;
            Object binder = getService != null ? getService.invoke(null, "activity_task") : null;
            if (binder == null) return null;
            Class<?> stub = cachedClassForName("android.app.IActivityTaskManager$Stub");
            Method asInterface = stub != null ? findMethod(stub, "asInterface", android.os.IBinder.class) : null;
            Object svc = asInterface != null ? asInterface.invoke(null, binder) : null;
            if (svc != null) cachedAtmService = svc;
            return svc;
        } catch (Throwable ignored) {
            return null;
        }
    }

    private Context getSystemContext() {
        Context cached = cachedSystemContext;
        if (cached != null) return cached;
        try {
            Class<?> activityThread = cachedClassForName("android.app.ActivityThread");
            Method current = activityThread != null ? findMethod(activityThread, "currentActivityThread") : null;
            Object thread = current != null ? current.invoke(null) : null;
            if (thread == null) return null;
            Method getSystemContext = findMethod(activityThread, "getSystemContext");
            Context ctx = (Context) getSystemContext.invoke(thread);
            if (ctx != null) cachedSystemContext = ctx;
            return ctx;
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
                        directIntervalMs = clampDirectInterval(dps.getLong("interval_ms", 30000L));
                        directUploadForeground = dps.getBoolean("upload_foreground", true);
                        directUploadMedia = dps.getBoolean("upload_media", true);
                        directUploadNetwork = dps.getBoolean("upload_network", true);
                        directUploadVpn = dps.getBoolean("upload_vpn", false);
                        directUploadInput = dps.getBoolean("upload_input", false);
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
            directIntervalMs = clampDirectInterval(prefs.getLong("interval_ms", 30000L));
            directUploadForeground = prefs.getBoolean("upload_foreground", true);
            directUploadMedia = prefs.getBoolean("upload_media", true);
            directUploadNetwork = prefs.getBoolean("upload_network", true);
            directUploadVpn = prefs.getBoolean("upload_vpn", false);
            directUploadInput = prefs.getBoolean("upload_input", false);
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
            boolean uploadNetwork = intent.getBooleanExtra("upload_network", true);
            boolean uploadVpn = intent.getBooleanExtra("upload_vpn", false);
            boolean uploadInput = intent.getBooleanExtra("upload_input", false);

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
                        .putLong("interval_ms", clampDirectInterval(intervalSec * 1000L))
                        .putBoolean("upload_foreground", uploadForeground)
                        .putBoolean("upload_media", uploadMedia)
                        .putBoolean("upload_network", uploadNetwork)
                        .putBoolean("upload_vpn", uploadVpn)
                        .putBoolean("upload_input", uploadInput)
                        .commit();
            } catch (Throwable ignored) {}

            // IMPORTANT: Set volatile fields directly from broadcast extras.
            // Do NOT rely on getRemotePreferences() to read back from the above storage,
            // because it may read from a different storage location (LSPosed framework
            // storage vs system_server device-protected storage).
            directUploadEnabled = enabled;
            directServerUrl = serverUrl;
            directToken = token;
            directIntervalMs = clampDirectInterval(intervalSec * 1000L);
            directUploadForeground = uploadForeground;
            directUploadMedia = uploadMedia;
            directUploadNetwork = uploadNetwork;
            directUploadVpn = uploadVpn;
            directUploadInput = uploadInput;
            log(Log.INFO, TAG, "config applied from broadcast: enabled=" + enabled + " url=" + serverUrl + " token=" + (token.length() > 0 ? "set" : "empty"));

            maybeDirectUpload(true);
        } catch (Throwable t) {
            log(Log.WARN, TAG, "save config failed: " + t.getClass().getSimpleName());
        }
    }

    private void maybeDirectUpload(boolean force) {
        if (!directUploadEnabled || directServerUrl.length() == 0 || directToken.length() == 0) return;
        // Only system_server should perform network uploads.
        // Browser processes have uninitialized uploadHandler and would block the main thread (ANR).
        // system_server process name is "system", app process name is TARGET_PACKAGE ("com.monika.dashboard")
        if (!"system".equals(currentProcessName)) return;
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
        Handler handler = getUploadHandler();
        if (handler == null) {
            pendingDirectBody = body;
            log(Log.WARN, TAG, "upload skipped: background handler unavailable");
            return;
        }
        handler.post(() -> {
            String pending = pendingDirectBody;
            if (pending.length() > 0 && !pending.equals(body)) {
                if (sendDirectReport(url, tok, pending)) {
                    pendingDirectBody = "";
                } else {
                    return;
                }
            }
            if (sendDirectReport(url, tok, body)) {
                if (body.equals(pendingDirectBody)) pendingDirectBody = "";
            } else {
                pendingDirectBody = body;
            }
        });
    }

    private boolean sendDirectReport(String url, String tok, String body) {
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
                    return true;
                }
            } catch (Throwable t) {
                log(Log.WARN, TAG, "ws send failed: " + t.getClass().getSimpleName());
            }
        }
        boolean ok = postDirectReportFallback(body);
        log(Log.INFO, TAG, "http fallback upload " + (ok ? "OK" : "failed"));
        return ok;
    }

    private long clampDirectInterval(long intervalMs) {
        return Math.max(MIN_DIRECT_UPLOAD_MS, Math.min(MAX_DIRECT_UPLOAD_MS, intervalMs));
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
            fillBatteryExtras(extra);
            JSONObject device = new JSONObject();
            device.put("capability_mode", "lsposed");
            device.put("uploader", "lsposed");
            device.put("last_sample_at", isoTime(now));
            // Multi-window / tablet detection
            device.put("device_kind", getDeviceFormFactor());
            String wm = getWindowingMode();
            if (wm != null) device.put("window_mode", wm);
            fillNetworkExtras(device);
            extra.put("device", device);
            extra.put("sleeping", "sleeping".equals(foregroundPackage));
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
            if (directUploadMedia && (mediaPlaying || mediaPackage.length() > 0 || mediaState.length() > 0)) {
                JSONObject media = new JSONObject();
                media.put("playing", mediaPlaying);
                if (mediaPlaying && mediaTitle.length() > 0) media.put("title", mediaTitle);
                if (mediaPlaying && mediaArtist.length() > 0) media.put("artist", mediaArtist);
                if (mediaApp.length() > 0) media.put("app", mediaApp);
                if (mediaPackage.length() > 0) media.put("package_name", mediaPackage);
                if (mediaState.length() > 0) media.put("state", mediaState);
                media.put("source", "lsposed");
                extra.put("media", media);
            }
            if (directUploadInput) {
                JSONObject input = new JSONObject();
                input.put("input_active", inputActive);
                input.put("is_typing", inputActive);
                input.put("source", "lsposed");
                extra.put("input", input);
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

    private void fillBatteryExtras(JSONObject extra) {
        try {
            Context ctx = getSystemContext();
            if (ctx == null) return;
            Intent intent = ctx.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (intent == null) return;
            int level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            if (level >= 0 && scale > 0) {
                int percent = Math.max(0, Math.min(100, Math.round((level * 100f) / scale)));
                extra.put("battery_percent", percent);
            }
            int status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            if (status >= 0) {
                extra.put("battery_charging",
                        status == BatteryManager.BATTERY_STATUS_CHARGING ||
                        status == BatteryManager.BATTERY_STATUS_FULL);
            }
        } catch (Throwable t) {
            log(Log.DEBUG, TAG, "battery extras skipped: " + t.getClass().getSimpleName());
        }
    }

    private void fillNetworkExtras(JSONObject device) {
        if (!directUploadNetwork && !directUploadVpn) return;
        try {
            Context ctx = getSystemContext();
            if (ctx == null) return;
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;

            boolean vpnActive = false;
            String activeType = "";
            String cellularGeneration = "";
            boolean connected = false;

            Network active = cm.getActiveNetwork();
            if (active != null) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(active);
                if (caps != null) {
                    connected = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
                    activeType = networkType(caps);
                    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
                        cellularGeneration = cellularGeneration();
                    }
                    vpnActive = caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
                }
            }

            if (directUploadVpn) {
                for (Network network : cm.getAllNetworks()) {
                    NetworkCapabilities caps = cm.getNetworkCapabilities(network);
                    if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                        vpnActive = true;
                        break;
                    }
                }
                device.put("vpn_active", vpnActive);
            }
            if (directUploadNetwork) {
                device.put("network_connected", connected);
                if (activeType.length() > 0) device.put("network_type", activeType);
                if (cellularGeneration.length() > 0) device.put("cellular_generation", cellularGeneration);
            }
        } catch (Throwable t) {
            log(Log.DEBUG, TAG, "network extras skipped: " + t.getClass().getSimpleName());
        }
    }

    private String networkType(NetworkCapabilities caps) {
        if (caps == null) return "";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return "Wi-Fi";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
            String gen = cellularGeneration();
            return gen.length() > 0 ? gen : "Cellular";
        }
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return "Ethernet";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH)) return "Bluetooth";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return "VPN";
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) ? "Online" : "offline";
    }

    private String cellularGeneration() {
        try {
            Context ctx = getSystemContext();
            if (ctx == null) return "";
            TelephonyManager tm = (TelephonyManager) ctx.getSystemService(Context.TELEPHONY_SERVICE);
            if (tm == null) return "";
            switch (tm.getDataNetworkType()) {
                case TelephonyManager.NETWORK_TYPE_NR:
                    return "5G";
                case TelephonyManager.NETWORK_TYPE_LTE:
                case TelephonyManager.NETWORK_TYPE_IWLAN:
                    return "4G";
                case TelephonyManager.NETWORK_TYPE_HSPAP:
                case TelephonyManager.NETWORK_TYPE_HSPA:
                case TelephonyManager.NETWORK_TYPE_HSDPA:
                case TelephonyManager.NETWORK_TYPE_HSUPA:
                case TelephonyManager.NETWORK_TYPE_UMTS:
                case TelephonyManager.NETWORK_TYPE_EVDO_0:
                case TelephonyManager.NETWORK_TYPE_EVDO_A:
                case TelephonyManager.NETWORK_TYPE_EVDO_B:
                case TelephonyManager.NETWORK_TYPE_EHRPD:
                    return "3G";
                case TelephonyManager.NETWORK_TYPE_EDGE:
                case TelephonyManager.NETWORK_TYPE_GPRS:
                case TelephonyManager.NETWORK_TYPE_CDMA:
                case TelephonyManager.NETWORK_TYPE_1xRTT:
                case TelephonyManager.NETWORK_TYPE_IDEN:
                    return "2G";
                default:
                    return "Cellular";
            }
        } catch (Throwable ignored) {
            return "";
        }
    }

    private boolean postDirectReportFallback(String body) {
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
                fetchQueuedMessagesFallback();
                return true;
            } else {
                log(Log.WARN, TAG, "http upload HTTP " + code);
            }
        } catch (Throwable t) {
            log(Log.WARN, TAG, "http fallback upload failed: " + t.getClass().getSimpleName());
        } finally {
            if (connection != null) connection.disconnect();
        }
        return false;
    }

    private void fetchQueuedMessagesFallback() {
        HttpURLConnection connection = null;
        try {
            if (!directUploadEnabled || directServerUrl.length() == 0 || directToken.length() == 0) return;
            URL url = new URL(directServerUrl + "/api/messages");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Authorization", "Bearer " + directToken);
            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) {
                log(Log.DEBUG, TAG, "message fallback fetch HTTP " + code);
                return;
            }
            String body = readUtf8(connection.getInputStream());
            JSONArray messages = new JSONObject(body).optJSONArray("messages");
            if (messages == null || messages.length() == 0) return;
            for (int i = 0; i < messages.length(); i++) {
                JSONObject item = messages.optJSONObject(i);
                if (item == null) continue;
                JSONObject data = new JSONObject()
                        .put("type", "viewer_message")
                        .put("message_id", item.optString("id", ""))
                        .put("viewer_id", item.optString("viewer_id", ""))
                        .put("viewer_name", item.optString("viewer_name", ""))
                        .put("kind", item.optString("kind", "private"))
                        .put("text", item.optString("text", ""));
                forwardViewerMessageToApp(data.toString());
            }
            log(Log.DEBUG, TAG, "message fallback fetch delivered " + messages.length());
        } catch (Throwable t) {
            log(Log.DEBUG, TAG, "message fallback fetch skipped: " + t.getClass().getSimpleName());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private String readUtf8(InputStream input) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int read;
        while ((read = input.read(buffer)) >= 0) {
            out.write(buffer, 0, read);
            if (out.size() > 256 * 1024) break;
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private void ensureWsConnected(String serverUrl, String token) {
        if (!directUploadEnabled || !"system".equals(currentProcessName)) return;
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

    /**
     * Schedule an immediate WebSocket reconnection attempt (with backoff).
     * Called when the WS reader/ping loop detects disconnection.
     * This ensures we don't wait for the next heartbeat (up to 5 min) to reconnect.
     */
    private void scheduleWsReconnect() {
        if (!directUploadEnabled || directServerUrl.length() == 0 || directToken.length() == 0 || !"system".equals(currentProcessName)) return;
        if (wsReconnectPending) return;
        wsReconnectPending = true;
        // Reconnect and immediately send the current snapshot. Reconnecting alone
        // would leave the dashboard stale until the next 5-minute heartbeat.
        Handler handler = getUploadHandler();
        if (handler == null) {
            wsReconnectPending = false;
            return;
        }
        handler.post(() -> {
            wsReconnectPending = false;
            maybeDirectUpload(true);
        });
    }

    private void forwardViewerMessageToApp(String payloadText) {
        try {
            JSONObject data = new JSONObject(payloadText);
            if (!"viewer_message".equals(data.optString("type"))) return;
            String viewerId = data.optString("viewer_id", "");
            String text = data.optString("text", "");
            if (viewerId.length() == 0 || text.length() == 0) return;

            Intent intent = new Intent(ACTION_MESSAGE);
            intent.setComponent(new ComponentName(TARGET_PACKAGE, TARGET_RECEIVER));
            intent.putExtra("message_id", data.optString("message_id", ""));
            intent.putExtra("viewer_id", viewerId);
            intent.putExtra("viewer_name", data.optString("viewer_name", ""));
            intent.putExtra("kind", data.optString("kind", "private"));
            intent.putExtra("text", text);
            Context ctx = getSystemContext();
            if (ctx != null) {
                long token = Binder.clearCallingIdentity();
                try {
                    ctx.sendBroadcast(intent, CONFIG_PERMISSION);
                    postViewerMessageNotification(ctx, data, text, viewerId);
                } finally {
                    Binder.restoreCallingIdentity(token);
                }
                log(Log.DEBUG, TAG, "forwarded viewer message to app: " + viewerId);
            }
        } catch (Throwable t) {
            log(Log.DEBUG, TAG, "viewer message forward ignored: " + t.getClass().getSimpleName());
        }
    }

    private void postViewerMessageNotification(Context ctx, JSONObject data, String text, String viewerId) {
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel channel = new NotificationChannel(
                        MESSAGE_CHANNEL_ID,
                        "Monika网页消息",
                        NotificationManager.IMPORTANCE_HIGH);
                nm.createNotificationChannel(channel);
            }

            Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(TARGET_PACKAGE);
            if (launch == null) {
                launch = new Intent();
                launch.setComponent(new ComponentName(TARGET_PACKAGE, "com.monika.dashboard.MainActivity"));
            }
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            launch.putExtra("viewer_id", viewerId);
            launch.putExtra("message_id", data.optString("message_id", ""));

            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pendingIntent = PendingIntent.getActivity(
                    ctx,
                    viewerId.hashCode(),
                    launch,
                    flags);

            String title = "网页游客消息";
            String body = text.length() > 120 ? text.substring(0, 120) : text;
            Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(ctx, MESSAGE_CHANNEL_ID)
                    : new Notification.Builder(ctx);
            builder.setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setStyle(new Notification.BigTextStyle().bigText(text.length() > 500 ? text.substring(0, 500) : text))
                    .setContentIntent(pendingIntent)
                    .setAutoCancel(true)
                    .setShowWhen(true)
                    .setWhen(System.currentTimeMillis())
                    .setCategory(Notification.CATEGORY_MESSAGE)
                    .setPriority(Notification.PRIORITY_HIGH);
            nm.notify(MESSAGE_NOTIFICATION_ID, builder.build());
        } catch (Throwable t) {
            log(Log.DEBUG, TAG, "LSP message notification skipped: " + t.getClass().getSimpleName());
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
        // Screen off — show sleeping or media info
        if ("sleeping".equals(foregroundPackage)) {
            if (mediaPlaying && mediaTitle.length() > 0 && mediaApp.length() > 0) {
                return mediaApp + "正在播放" + mediaTitle;
            }
            return "(-.-)zzZ";
        }
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
        String cacheKey = clazz.getName() + "#" + methodName;
        Object cached = methodLookupCache.get(cacheKey);
        if (cached instanceof Method) {
            try { return ((Method) cached).invoke(target instanceof Class<?> ? null : target); } catch (Throwable ignored) {}
        }
        if (cached == REFLECTION_MISS) return null;
        while (clazz != null) {
            try {
                Method method = clazz.getDeclaredMethod(methodName);
                method.setAccessible(true);
                methodLookupCache.put(cacheKey, method);
                return method.invoke(target instanceof Class<?> ? null : target);
            } catch (Throwable ignored) {
                clazz = clazz.getSuperclass();
            }
        }
        methodLookupCache.put(cacheKey, REFLECTION_MISS);
        return null;
    }

    private Object readField(Object target, String fieldName) {
        if (target == null) return null;
        Class<?> clazz = target.getClass();
        String cacheKey = clazz.getName() + "." + fieldName;
        Object cached = fieldLookupCache.get(cacheKey);
        if (cached instanceof Field) {
            try { return ((Field) cached).get(target); } catch (Throwable ignored) {}
        }
        if (cached == REFLECTION_MISS) return null;
        while (clazz != null) {
            try {
                Field field = clazz.getDeclaredField(fieldName);
                field.setAccessible(true);
                fieldLookupCache.put(cacheKey, field);
                return field.get(target);
            } catch (Throwable ignored) {
                clazz = clazz.getSuperclass();
            }
        }
        fieldLookupCache.put(cacheKey, REFLECTION_MISS);
        return null;
    }

    private Object readStaticField(Class<?> clazz, String fieldName) {
        if (clazz == null) return null;
        String cacheKey = clazz.getName() + "." + fieldName;
        Object cached = fieldLookupCache.get(cacheKey);
        if (cached instanceof Field) {
            try { return ((Field) cached).get(null); } catch (Throwable ignored) {}
        }
        if (cached == REFLECTION_MISS) return null;
        Class<?> current = clazz;
        while (current != null) {
            try {
                Field field = current.getDeclaredField(fieldName);
                field.setAccessible(true);
                fieldLookupCache.put(cacheKey, field);
                return field.get(null);
            } catch (Throwable ignored) {
                current = current.getSuperclass();
            }
        }
        fieldLookupCache.put(cacheKey, REFLECTION_MISS);
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

    private String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && value.trim().length() > 0) return value;
        }
        return null;
    }

    private String safeString(String value) {
        return value == null ? "" : value.trim();
    }

    private boolean isScreenInteractive() {
        try {
            Context ctx = getSystemContext();
            if (ctx == null) return true; // assume interactive if we can't check
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm == null) return true;
            return pm.isInteractive();
        } catch (Throwable t) {
            return true; // assume interactive on error
        }
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
        private static final int SOCKET_TIMEOUT_MS = 60_000; // 60s read timeout
        private static final int PING_INTERVAL_MS = 30_000;  // send ping every 30s
        private final byte[] recvBuf = new byte[RECEIVE_BUF];
        private final byte[] pingPayload = new byte[0]; // empty ping payload

        private final String wsUrl;
        private final String authHeader;
        private final SecureRandom secureRandom = new SecureRandom();
        private java.net.Socket socket;
        private InputStream in;
        private OutputStream out;
        private Thread readerThread;
        private Thread pingThread;
        private volatile boolean connected;
        private volatile boolean running;
        private volatile boolean manualDisconnect;

        private void clearModuleClientIfCurrent() {
            if (MonikaXposedModule.this.wsClient == this) {
                MonikaXposedModule.this.wsClient = null;
            }
        }

        LspWebSocketClient(String wsUrl, String authHeader) {
            this.wsUrl = wsUrl;
            this.authHeader = authHeader;
        }

        boolean isConnected() {
            return connected && socket != null && !socket.isClosed() && socket.isConnected();
        }

        void connect() throws Exception {
            URI uri = URI.create(wsUrl);
            manualDisconnect = false;
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
                ssl.setSoTimeout(SOCKET_TIMEOUT_MS); // read timeout — detect dead connections
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
                plain.setSoTimeout(SOCKET_TIMEOUT_MS);
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

            // Start ping thread — sends periodic pings to keep connection alive
            // and detect dead connections early (server pong timeout = 2x PING_INTERVAL)
            pingThread = new Thread(this::pingLoop, "LspWsPing");
            pingThread.setDaemon(true);
            pingThread.start();
        }

        void disconnect() {
            manualDisconnect = true;
            running = false;
            connected = false;
            // Interrupt threads to unblock socket reads during close
            if (pingThread != null) { try { pingThread.interrupt(); } catch (Throwable ignored) {} }
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
                if (!manualDisconnect) scheduleWsReconnect();
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
            boolean unexpectedDisconnect = false;
            try {
                while (running && connected) {
                    byte[] frame = readFrame();
                    if (frame == null) {
                        // EOF — server closed connection without close frame
                        unexpectedDisconnect = true;
                        break;
                    }
                    int opcode = frame[0] & 0x0F;
                    int payloadLen = frame.length - 1;
                    byte[] payload = payloadLen > 0 ? new byte[payloadLen] : new byte[0];
                    if (payloadLen > 0) System.arraycopy(frame, 1, payload, 0, payloadLen);

                    switch (opcode) {
                        case OP_TEXT:
                            forwardViewerMessageToApp(new String(payload, StandardCharsets.UTF_8));
                            break;
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
                            // Server closed — cleanup and schedule immediate reconnect
                            connected = false;
                            running = false;
                            closeQuietly();
                            clearModuleClientIfCurrent();
                            if (!manualDisconnect) scheduleWsReconnect();
                            return;
                        default:
                            // Ignore other frame types (ack, messages, etc.)
                            break;
                    }
                }
            } catch (Throwable t) {
                // Connection lost — trigger immediate reconnect
                log(Log.DEBUG, TAG, "WS reader error: " + t.getClass().getSimpleName());
                connected = false;
                if (!manualDisconnect) scheduleWsReconnect();
            } finally {
                connected = false;
                running = false;
                closeQuietly();
                clearModuleClientIfCurrent();
                if (unexpectedDisconnect && !manualDisconnect) {
                    scheduleWsReconnect();
                }
            }
        }

        /**
         * Periodic ping loop — sends a WebSocket ping every PING_INTERVAL_MS.
         * This keeps the connection alive through NAT/firewall timeouts and
         * detects dead connections faster than TCP keepalive.
         */
        private void pingLoop() {
            while (running && connected) {
                try {
                    Thread.sleep(PING_INTERVAL_MS);
                } catch (InterruptedException e) {
                    break;
                }
                if (!running || !connected || out == null) break;
                try {
                    synchronized (out) {
                        sendFrame(OP_PING, pingPayload, true);
                        out.flush();
                    }
                } catch (Throwable t) {
                    // Write failed — connection is dead
                    log(Log.DEBUG, TAG, "WS ping failed: " + t.getClass().getSimpleName());
                    connected = false;
                    break;
                }
            }
            // If ping loop exits due to error, trigger cleanup
            if ((!running || !connected) && !manualDisconnect) {
                connected = false;
                running = false;
                closeQuietly();
                clearModuleClientIfCurrent();
                scheduleWsReconnect();
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
