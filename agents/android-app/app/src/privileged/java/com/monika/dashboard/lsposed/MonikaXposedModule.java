package com.monika.dashboard.lsposed;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.BroadcastOptions;
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
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
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
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;

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
    private static final String PREFS_DIRECT_UPLOAD = "monika_lsp_direct_upload";
    private static final String KEY_PENDING_DIRECT_BODY = "pending_direct_body";
    private static final String KEY_BROWSER_TITLE_NONCE = "browser_title_nonce";
    private static final String EXTRA_CONFIG_COMMAND = "command";
    private static final String COMMAND_CLEAR_SUPERVISION_FREEZE = "clear_supervision_freeze";
    private static final String EXTRA_MEDIA_PLAYING = "media_playing";
    private static final String EXTRA_MEDIA_PACKAGE = "media_package";
    private static final String EXTRA_MEDIA_TITLE = "media_title";
    private static final String EXTRA_MEDIA_ARTIST = "media_artist";
    private static final String EXTRA_MEDIA_APP = "media_app";
    private static final String EXTRA_MEDIA_STATE = "media_state";
    private static final String MESSAGE_CHANNEL_ID = "monika_lsp_messages";
    private static final int MESSAGE_NOTIFICATION_ID = 2002;
    private static final String SUPERVISION_CHANNEL_ID = "monika_lsp_supervision";
    private static final int SUPERVISION_FREEZE_NOTIFICATION_ID = 2003;
    private static final long HEARTBEAT_MS = 5 * 60_000L; // low-frequency fallback; events drive normal uploads
    private static final long BROADCAST_DEBOUNCE_MS = 1500L;
    private static final long MIN_DIRECT_UPLOAD_MS = 5000L;
    private static final long MAX_DIRECT_UPLOAD_MS = 45_000L;
    private static final String OFFLINE_TIMEOUT_FIELD = "offline_timeout_minutes";
    private static final int MAX_REPORTED_OFFLINE_TIMEOUT_MINUTES = 60;
    private static final int REPORTED_OFFLINE_TIMEOUT_GRACE_MINUTES = 2;
    private static final long IDLE_DEBOUNCE_COUNT = 2; // 2 consecutive heartbeats before reporting idle
    private static final long WS_RETRY_BASE_MS = 30_000L;  // first retry delay
    private static final long WS_RETRY_MAX_MS = 300_000L;  // max retry delay (5 min)
    private static final long MEDIA_VALIDATE_MS = 60_000L; // low-frequency stale-session guard
    private static final long BROWSER_NONCE_RELOAD_MS = 60_000L;
    private static final long BROWSER_WEB_TITLE_FRESH_MS = 10_000L;
    private static final long DIRECT_FULL_STATE_INTERVAL_MS = 5 * 60_000L;
    private static final long AMBIENT_LIGHT_CACHE_MS = 60_000L;
    private static final long SUPERVISION_DEFAULT_FREEZE_MS = 10 * 60_000L;
    private static final long SUPERVISION_CHECK_REQUEST_MIN_MS = 60_000L;
    private static final long SUPERVISION_CHECK_REQUEST_SAME_KEY_MS = 5 * 60_000L;
    private static final int SUPERVISION_DAILY_UNFREEZE_HOUR = 3;
    
    // Static instance for global access
    private static MonikaXposedModule instance;
    
    private volatile int idleConsecutiveCount = 0;
    private volatile boolean foregroundSnapshotPending = false;
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
    private volatile boolean internalMediaHooksInstalled = false;
    private volatile boolean screenReceiverRegistered = false;
    private final java.util.Map<Object, MediaControllerRegistration> registeredMediaControllers =
            java.util.Collections.synchronizedMap(new java.util.HashMap<>());
    private final java.util.Set<String> hookedWebChromeClientClasses =
            java.util.Collections.synchronizedSet(new java.util.HashSet<>());
    private final java.util.Set<String> hookedWebViewClientClasses =
            java.util.Collections.synchronizedSet(new java.util.HashSet<>());
    private final java.util.Set<String> scheduledWebViewTitleReads =
            java.util.Collections.synchronizedSet(new java.util.HashSet<>());
    private MediaSessionManager mediaSessionManager;
    private volatile String currentProcessName = "";
    private volatile boolean systemServerProcess = false;
    private volatile boolean browserTitleReceiverRegistered = false;
    private volatile boolean dailyFreezeCleanupScheduled = false;
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
    private volatile String browserTitleNonce = "";
    private volatile long lastDirectUploadAt = 0L;
    private volatile String pendingDirectBody = "";
    private volatile LspWebSocketClient wsClient = null;
    private volatile boolean wsReconnectPending = false;
    private volatile long lastSupervisionCheckRequestAt = 0L;
    private volatile String lastSupervisionCheckRequestKey = "";
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
    private volatile String foregroundTitleSource = "";
    private volatile long foregroundTitleUpdatedAt = 0L;
    private volatile long lastMediaValidationAt = 0L;
    private volatile long lastTitleBroadcastAt = 0L;
    private volatile String lastBroadcastTitle = "";
    private volatile long lastBrowserNonceLoadAt = 0L;
    private volatile String lastDirectStateSignature = "";
    private volatile long lastDirectFullReportAt = 0L;
    private volatile float lastAmbientLux = -1f;
    private volatile long lastAmbientLightAt = 0L;
    private volatile boolean ambientLightListenerRegistered = false;
    private volatile String recentForegroundBrowser = "";
    private volatile long recentForegroundBrowserAt = 0L;
    private volatile long lastScreenOffCheckAt = 0L;
    private volatile SupervisionFreezeAlert activeFreezeAlert = null;
    private final ConcurrentHashMap<String, FrozenPackageRecord> frozenPackages = new ConcurrentHashMap<>();
    private static final long SCREEN_OFF_DEBOUNCE_MS = 30_000L; // 30s debounce for sleep detection
    private static final long TOP_ACTIVITY_FALLBACK_MS = 120_000L;
    private volatile ComponentName lastKnownTopComponent = null;
    private volatile long lastKnownTopAt = 0L;
    private static final Object REFLECTION_MISS = new Object();
    private static final String NO_ARG_SIG = "#";
    private final ConcurrentHashMap<String, Object> classCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Object> methodLookupCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Object> fieldLookupCache = new ConcurrentHashMap<>();

    private static final class MediaControllerRegistration {
        final MediaController controller;
        final MediaController.Callback callback;

        MediaControllerRegistration(MediaController controller, MediaController.Callback callback) {
            this.controller = controller;
            this.callback = callback;
        }

        void unregister() {
            try { controller.unregisterCallback(callback); } catch (Throwable ignored) {}
        }
    }

    @Override
    public void onModuleLoaded(@NonNull XposedModuleInterface.ModuleLoadedParam param) {
        instance = this;
        currentProcessName = param.getProcessName();
        systemServerProcess = param.isSystemServer();
        log(Log.INFO, TAG, "onModuleLoaded: isSystemServer=" + param.isSystemServer() 
                + " process=" + param.getProcessName() 
                + " apiVersion=" + getApiVersion() 
                + " framework=" + getFrameworkName() + " v" + getFrameworkVersion());
    }

    @Override
    public void onSystemServerStarting(@NonNull XposedModuleInterface.SystemServerStartingParam param) {
        ClassLoader cl = param.getClassLoader();
        systemServerProcess = true;
        initUploadThread();
        Handler handler = new Handler(Looper.getMainLooper());
        scheduleSystemServerReceivers(handler, 1500L);
        installInternalMediaHooks(cl);
        installForegroundSampler(cl);
        // Keyboard input state is intentionally not collected: it is noisy and
        // tends to pollute timeline semantics without adding reliable context.
    }

    @Override
    public void onPackageReady(@NonNull XposedModuleInterface.PackageReadyParam param) {
        String packageName = param.getPackageName();
        if (!isBrowserPackage(packageName)) return;
        // Hook likely browser UI processes only. Some OEM/system browsers keep their UI in
        // a named process, while renderer/gpu/sandbox/service processes must be ignored.
        String processName = currentProcessName;
        if (!shouldHookBrowserProcess(packageName, processName)) {
            logDebug("skip browser non-main process: " + packageName + "/" + processName);
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

            // AOSP uses onSystemReady on modern releases; keep systemReady as
            // a legacy/OEM fallback.
            Method readyMethod = findMethod(clazz, "onSystemReady");
            if (readyMethod == null) readyMethod = findMethod(clazz, "systemReady");
            if (readyMethod != null) {
                try { deoptimize(readyMethod); } catch (Throwable ignored) {}
                hook(readyMethod)
                        .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                        .intercept(chain -> {
                            Object result = chain.proceed();
                            startForegroundSampler();
                            return result;
                        });
                log(Log.INFO, TAG, "hooked ActivityTaskManagerService#" + readyMethod.getName());
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
                            scheduleForegroundSnapshot(300L);
                            return result;
                        });
                log(Log.INFO, TAG, "hooked ActivityTaskManagerService#moveTaskToFront (event-driven)");
            }
            int foregroundHooks = installForegroundResumeEventHooks(cl);
            if (foregroundHooks > 0) {
                log(Log.INFO, TAG, "hooked foreground resume event methods: " + foregroundHooks);
            }
        } catch (Throwable t) {
            log(Log.WARN, TAG, "foreground sampler hook skipped: " + t.getClass().getSimpleName());
            startForegroundSampler();
        }
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
            Class<?> clazz = cachedClassForName(className, cl);
            if (clazz == null) return 0;
            int hooked = 0;
            for (Method method : clazz.getDeclaredMethods()) {
                if (!isNamed(method.getName(), methodNames)) continue;
                try { method.setAccessible(true); } catch (Throwable ignored) {}
                try { deoptimize(method); } catch (Throwable ignored) {}
                try {
                    hook(method)
                            .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                            .intercept(chain -> {
                                Object result = chain.proceed();
                                if (foregroundEventLikelyChanged(result)) {
                                    scheduleForegroundSnapshot(delayMs);
                                }
                                return result;
                            });
                    hooked++;
                } catch (Throwable ignored) {}
            }
            return hooked;
        } catch (Throwable t) {
            logDebug("foreground event hook skipped for " + className + ": " + t.getClass().getSimpleName());
            return 0;
        }
    }

    private boolean isNamed(String value, String... names) {
        if (value == null || names == null) return false;
        for (String name : names) {
            if (value.equals(name)) return true;
        }
        return false;
    }

    private boolean foregroundEventLikelyChanged(Object result) {
        if (result instanceof Boolean) return (Boolean) result;
        if (result instanceof Integer) return ((Integer) result) >= 0;
        return true;
    }

    private void scheduleForegroundSnapshot(long delayMs) {
        if (foregroundSnapshotPending) return;
        foregroundSnapshotPending = true;
        try {
            Handler handler = new Handler(Looper.getMainLooper());
            handler.postDelayed(() -> {
                foregroundSnapshotPending = false;
                try { broadcastSnapshot(); } catch (Throwable ignored) {}
            }, Math.max(0L, delayMs));
        } catch (Throwable t) {
            foregroundSnapshotPending = false;
            try { broadcastSnapshot(); } catch (Throwable ignored) {}
        }
    }

    private void forceForegroundSnapshot() {
        foregroundSnapshotPending = false;
        scheduleForegroundSnapshot(0L);
    }

    private void startForegroundSampler() {
        if (samplerStarted) return;
        try {
            Handler handler = new Handler(Looper.getMainLooper());
            samplerStarted = true;
            // Keep the delayed pass as a system-ready fallback for ROMs where
            // the system context or MediaSessionService appears late.
            scheduleSystemServerReceivers(handler, 10000L);
            scheduleDailyFreezeCleanup(handler);
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
                    String command = safeString(intent.getStringExtra(EXTRA_CONFIG_COMMAND));
                    if (COMMAND_CLEAR_SUPERVISION_FREEZE.equals(command)) {
                        clearSupervisionFreeze("app command");
                        return;
                    }
                    saveDirectUploadConfig(receiverContext, intent);
                }
            };
            ContextCompat.registerReceiver(
                    context,
                    configReceiver,
                    filter,
                    CONFIG_PERMISSION,
                    handler,
                    ContextCompat.RECEIVER_EXPORTED);
            configReceiverRegistered = true;
            log(Log.INFO, TAG, "registered direct upload config receiver");
        } catch (Throwable t) {
            log(Log.WARN, TAG, "config receiver failed: " + t.getClass().getSimpleName());
        }
    }

    private void scheduleSystemServerReceivers(Handler handler, long delayMs) {
        if (handler == null || !isSystemServerProcess()) return;
        handler.postDelayed(() -> {
            try { loadDirectUploadConfig(); } catch (Throwable t) { log(Log.WARN, TAG, "deferred load config failed: " + t.getClass().getSimpleName()); }
            try { registerConfigReceiver(handler); } catch (Throwable t) { log(Log.WARN, TAG, "deferred register receiver failed: " + t.getClass().getSimpleName()); }
            try { registerBrowserTitleReceiver(handler); } catch (Throwable t) { log(Log.WARN, TAG, "deferred register browser title receiver failed: " + t.getClass().getSimpleName()); }
            try { registerScreenStateReceiver(handler); } catch (Throwable t) { log(Log.WARN, TAG, "deferred register screen receiver failed: " + t.getClass().getSimpleName()); }
            try { initMediaSessionListener(); } catch (Throwable t) { log(Log.WARN, TAG, "deferred init media listener failed: " + t.getClass().getSimpleName()); }
            try { broadcastSnapshot(); } catch (Throwable t) { logDebug("deferred initial snapshot skipped: " + t.getClass().getSimpleName()); }
        }, Math.max(0L, delayMs));
    }

    private void scheduleDailyFreezeCleanup(Handler handler) {
        if (handler == null || dailyFreezeCleanupScheduled || !isSystemServerProcess()) return;
        dailyFreezeCleanupScheduled = true;
        long now = System.currentTimeMillis();
        long delay = Math.max(1000L, nextDailyUnfreezeAt(now) - now);
        handler.postDelayed(() -> {
            dailyFreezeCleanupScheduled = false;
            clearSupervisionFreeze("daily reset");
            scheduleDailyFreezeCleanup(handler);
        }, delay);
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
                    String source = safeString(intent.getStringExtra("source"));
                    if (!isBrowserPackage(pkg)) return;
                    String cleanTitle = cleanBrowserTitle(pkg, title);
                    boolean genericTitle = cleanTitle == null && isGenericBrowserTitle(pkg, title);
                    boolean clearGenericTitle = genericTitle
                            && (intent.getBooleanExtra("clear_title", false) || isWebTitleSource(source));
                    if (cleanTitle == null && !clearGenericTitle) return;

                    // Security: verify sender identity on API 34+ when the sender enables
                    // BroadcastOptions#setShareIdentityEnabled(true). On older systems,
                    // fall back to optional nonce validation plus foreground-browser check.
                    boolean senderVerified = false;
                    if (android.os.Build.VERSION.SDK_INT >= 34) {
                        try {
                            String sentPkg = getSentFromPackage();
                            if (sentPkg != null && !sentPkg.equals(pkg)) {
                                log(Log.WARN, TAG, "browser title rejected: sender=" + sentPkg + " claimed=" + pkg);
                                return;
                            }
                            senderVerified = sentPkg != null && sentPkg.equals(pkg);
                        } catch (Throwable ignored) {}
                    }
                    String expectedNonce = getBrowserTitleNonce(true);
                    String actualNonce = safeString(intent.getStringExtra(KEY_BROWSER_TITLE_NONCE));

                    // Verify the claimed package is (or recently was) the foreground browser.
                    // Use time-window cache (2s) to tolerate broadcast delay — avoids
                    // losing titles when user switches away just as broadcast arrives.
                    ComponentName top = getTopActivityComponentName();
                    boolean isCurrentForeground = top != null && pkg.equals(top.getPackageName());
                    boolean wasRecentForeground = pkg.equals(recentForegroundBrowser)
                            && System.currentTimeMillis() - recentForegroundBrowserAt < 2000L;
                    if (!isCurrentForeground && !wasRecentForeground) {
                        logDebug("browser title ignored: " + pkg + " is not foreground");
                        return;
                    }
                    if (!senderVerified && expectedNonce.length() > 0 && !expectedNonce.equals(actualNonce)) {
                        // Some ROM/browser processes cannot read the app-created nonce even
                        // though the broadcast comes from the active browser process. Keep the
                        // foreground-browser gate as the fallback trust boundary.
                        logDebug("browser title accepted without nonce for foreground browser: " + pkg);
                    }

                    foregroundPackage = pkg;
                    foregroundApp = safeString(resolveAppLabel(pkg));
                    foregroundActivity = safeString(activity);
                    if (!shouldApplyBrowserTitleCandidate(pkg, cleanTitle, source)) {
                        logDebug("browser title ignored by source priority: " + pkg + " title=" + cleanTitle + " source=" + source);
                        return;
                    }

                    applyForegroundTitle(cleanTitle != null ? cleanTitle : "", source);
                    logDebug("browser title received: " + pkg + " title=" + foregroundTitle + " source=" + source);
                    maybeApplySupervisionFreeze(foregroundPackage, foregroundApp, foregroundTitle);
                    maybeDirectUpload(true);
                }
            };
            ContextCompat.registerReceiver(
                    context,
                    receiver,
                    filter,
                    null,
                    handler,
                    ContextCompat.RECEIVER_EXPORTED);
            browserTitleReceiverRegistered = true;
            log(Log.INFO, TAG, "registered browser title receiver");
        } catch (Throwable t) {
            log(Log.WARN, TAG, "browser title receiver failed: " + t.getClass().getSimpleName());
        }
    }

    /**
     * Initialize MediaSessionManager listener for media capture.
     * Public MediaController callbacks are kept as a fallback. The primary path
     * in system_server is the internal MediaSessionRecord hook installed above.
     * Reference: SuperLyric (PlayStateListener), HyperLyric (MediaMetadataHelper)
     */
    private void installInternalMediaHooks(ClassLoader cl) {
        if (internalMediaHooksInstalled) return;
        try {
            Class<?> record = cachedClassForName("com.android.server.media.MediaSessionRecord", cl);
            Class<?> sessionStub = cachedClassForName("com.android.server.media.MediaSessionRecord$SessionStub", cl);
            if (record == null && sessionStub == null) throw new ClassNotFoundException("MediaSessionRecord");
            int hooked = 0;
            if (record != null) {
                hooked += hookMediaSessionRecordMethod(record, "setPlaybackState");
                hooked += hookMediaSessionRecordMethod(record, "setMetadata");
            }
            if (sessionStub != null) {
                hooked += hookMediaSessionRecordMethod(sessionStub, "setPlaybackState");
                hooked += hookMediaSessionRecordMethod(sessionStub, "setMetadata");
            }
            if (hooked > 0) {
                internalMediaHooksInstalled = true;
                log(Log.INFO, TAG, "hooked MediaSessionRecord media methods: " + hooked);
            }
        } catch (Throwable t) {
            log(Log.WARN, TAG, "internal media hooks skipped: " + t.getClass().getSimpleName());
        }
    }

    private int hookMediaSessionRecordMethod(Class<?> record, String methodName) {
        int hooked = 0;
        for (Method method : record.getDeclaredMethods()) {
            if (!methodName.equals(method.getName())) continue;
            try { method.setAccessible(true); } catch (Throwable ignored) {}
            try { deoptimize(method); } catch (Throwable ignored) {}
            try {
                hook(method)
                        .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                        .intercept(chain -> {
                            Object result = chain.proceed();
                            try {
                                MediaMetadata metadata = null;
                                PlaybackState state = null;
                                for (Object arg : chain.getArgs()) {
                                    if (arg instanceof MediaMetadata) metadata = (MediaMetadata) arg;
                                    if (arg instanceof PlaybackState) state = (PlaybackState) arg;
                                }
                                updateMediaFromSessionRecord(chain.getThisObject(), state, metadata);
                            } catch (Throwable t) {
                                logDebug("media record hook ignored: " + t.getClass().getSimpleName());
                            }
                            return result;
                        });
                hooked++;
            } catch (Throwable ignored) {}
        }
        return hooked;
    }

    private void updateMediaFromSessionRecord(Object record, PlaybackState state, MediaMetadata metadata) {
        if (record == null) return;
        record = mediaRecordFromHookThis(record);
        if (state == null) state = playbackStateFromRecord(record);
        if (metadata == null) metadata = metadataFromRecord(record);
        String pkg = sessionRecordPackage(record);
        if (pkg.length() == 0 && mediaPackage.length() == 0) return;

        String beforeMedia = mediaInfoKey();
        boolean knownPlaying = state == null && metadata != null && mediaPlaying
                && (pkg.length() == 0 || pkg.equals(mediaPackage));
        boolean nextPlaying = knownPlaying || (state != null && state.getState() == PlaybackState.STATE_PLAYING);
        if (state == null && !nextPlaying) return;
        if (!nextPlaying) {
            if (pkg.length() == 0 || pkg.equals(mediaPackage)) {
                clearMediaInfo();
                if (pkg.length() > 0) {
                    mediaPackage = safeString(pkg);
                    mediaApp = safeString(resolveAppLabel(pkg));
                    mediaState = safeString(playbackStateName(state));
                }
            }
            maybeDirectUpload(!beforeMedia.equals(mediaInfoKey()));
            return;
        }

        mediaPlaying = true;
        mediaPackage = safeString(pkg);
        mediaApp = safeString(resolveAppLabel(pkg));
        mediaState = safeString(playbackStateName(state));
        mediaTitle = "";
        mediaArtist = "";
        if (metadata != null) {
            String nextTitle = safeString(firstNonBlank(
                    mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_DISPLAY_TITLE),
                    mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_TITLE)));
            String nextArtist = safeString(firstNonBlank(
                    mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_ARTIST),
                    mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_AUTHOR),
                    mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_ALBUM_ARTIST)));
            mediaTitle = nextTitle;
            mediaArtist = nextArtist;
        }
        lastMediaValidationAt = System.currentTimeMillis();
        maybeDirectUpload(!beforeMedia.equals(mediaInfoKey()));
    }

    private Object mediaRecordFromHookThis(Object value) {
        Object outer = readField(value, "this$0");
        if (outer == null) outer = readField(value, "mSessionRecord");
        if (outer == null) outer = readField(value, "mRecord");
        if (outer == null) outer = readField(value, "mSession");
        return outer != null ? outer : value;
    }

    private PlaybackState playbackStateFromRecord(Object record) {
        Object value = callAny(record, "getPlaybackState");
        if (!(value instanceof PlaybackState)) value = readField(record, "mPlaybackState");
        if (!(value instanceof PlaybackState)) value = readField(record, "mPlaybackStateCache");
        return value instanceof PlaybackState ? (PlaybackState) value : null;
    }

    private MediaMetadata metadataFromRecord(Object record) {
        Object value = callAny(record, "getMetadata");
        if (!(value instanceof MediaMetadata)) value = readField(record, "mMetadata");
        if (!(value instanceof MediaMetadata)) value = readField(record, "mMetadataCache");
        return value instanceof MediaMetadata ? (MediaMetadata) value : null;
    }

    private String sessionRecordPackage(Object record) {
        Object value = callAny(record, "getPackageName");
        if (!(value instanceof String)) value = readField(record, "mPackageName");
        if (!(value instanceof String)) value = readField(record, "mOwnerPackageName");
        if (!(value instanceof String)) value = readField(record, "mCallingPackage");
        return value instanceof String ? safeString((String) value) : "";
    }

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
                            logDebug("active sessions changed: " + controllers.size());
                            String beforeMedia = mediaInfoKey();
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
                                    logDebug("media session removed: " + trackedPkg + ", clearing media info");
                                    clearMediaInfo();
                                }
                            }
                            for (MediaController controller : controllers) {
                                registerMediaControllerCallback(controller);
                            }
                            refreshMediaFromControllers(controllers);
                            // Cleanup: remove stale entries from registeredMediaControllers
                            // that are no longer in the active session list
                            java.util.Set<Object> activeKeys = new java.util.HashSet<>();
                            for (MediaController c : controllers) {
                                activeKeys.add(mediaControllerKey(c));
                            }
                            cleanupStaleMediaControllerCallbacks(activeKeys);
                            maybeDirectUpload(!beforeMedia.equals(mediaInfoKey()));
                        } catch (Throwable t) {
                            log(Log.WARN, TAG, "onActiveSessionsChanged failed: " + t.getClass().getSimpleName());
                        }
                    }, null);
            List<MediaController> active = mediaSessionManager.getActiveSessions(null);
            String beforeMedia = mediaInfoKey();
            if (active != null) {
                log(Log.INFO, TAG, "initial active media sessions: " + active.size());
                for (MediaController controller : active) {
                    registerMediaControllerCallback(controller);
                }
                refreshMediaFromControllers(active);
            }
            mediaListenerRegistered = true;
            maybeDirectUpload(!beforeMedia.equals(mediaInfoKey()));
            log(Log.INFO, TAG, "MediaSessionManager listener registered");
        } catch (Throwable t) {
            log(Log.WARN, TAG, "initMediaSessionListener failed: " + t.getClass().getSimpleName());
        }
    }

    private void registerMediaControllerCallback(MediaController controller) {
        if (controller == null) return;
        Object key = mediaControllerKey(controller);
        synchronized (registeredMediaControllers) {
            if (registeredMediaControllers.containsKey(key)) return;
        }
        try {
            MediaController.Callback callback = new MediaController.Callback() {
                @Override
                public void onPlaybackStateChanged(PlaybackState state) {
                    try {
                        if (state == null) return;
                        String beforeMedia = mediaInfoKey();
                        String pkg = controller.getPackageName();
                        boolean nextPlaying = state.getState() == PlaybackState.STATE_PLAYING;
                        if (!nextPlaying) {
                            refreshActiveMediaState();
                            logDebug("media playback stopped/paused: pkg=" + pkg);
                            maybeDirectUpload(!beforeMedia.equals(mediaInfoKey()));
                            return;
                        }
                        mediaPlaying = true;
                        mediaPackage = safeString(pkg);
                        mediaApp = safeString(resolveAppLabel(pkg));
                        mediaState = safeString(playbackStateName(state));
                        mediaTitle = "";
                        mediaArtist = "";
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
                        logDebug("media playback: pkg=" + pkg + " playing=" + mediaPlaying + " title=" + mediaTitle);
                        maybeDirectUpload(!beforeMedia.equals(mediaInfoKey()));
                    } catch (Throwable t) {
                        log(Log.WARN, TAG, "onPlaybackStateChanged failed: " + t.getClass().getSimpleName());
                    }
                }

                @Override
                public void onMetadataChanged(MediaMetadata metadata) {
                    try {
                        String beforeMedia = mediaInfoKey();
                        String pkg = controller.getPackageName();
                        PlaybackState ps = controller.getPlaybackState();
                        mediaPlaying = ps != null && ps.getState() == PlaybackState.STATE_PLAYING;
                        if (!mediaPlaying) {
                            refreshActiveMediaState();
                            maybeDirectUpload(!beforeMedia.equals(mediaInfoKey()));
                            return;
                        }
                        mediaPackage = safeString(pkg);
                        mediaApp = safeString(resolveAppLabel(pkg));
                        mediaState = ps != null ? safeString(playbackStateName(ps)) : mediaState;
                        mediaTitle = "";
                        mediaArtist = "";
                        mediaTitle = safeString(firstNonBlank(
                                mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_DISPLAY_TITLE),
                                mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_TITLE)));
                        mediaArtist = safeString(firstNonBlank(
                                mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_ARTIST),
                                mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_AUTHOR),
                                mediaTextFromMeta(metadata, MediaMetadata.METADATA_KEY_ALBUM_ARTIST)));
                        logDebug("media metadata: pkg=" + pkg + " playing=" + mediaPlaying + " title=" + mediaTitle);
                        maybeDirectUpload(!beforeMedia.equals(mediaInfoKey()));
                    } catch (Throwable t) {
                        log(Log.WARN, TAG, "onMetadataChanged failed: " + t.getClass().getSimpleName());
                    }
                }

                @Override
                public void onSessionDestroyed() {
                    try {
                        unregisterMediaControllerCallback(key);
                        refreshActiveMediaState();
                        maybeDirectUpload(true);
                    } catch (Throwable ignored) {}
                }
            };
            Handler handler = getUploadHandler();
            if (handler != null) {
                controller.registerCallback(callback, handler);
            } else {
                controller.registerCallback(callback);
            }
            boolean duplicate = false;
            synchronized (registeredMediaControllers) {
                if (registeredMediaControllers.containsKey(key)) {
                    duplicate = true;
                } else {
                    registeredMediaControllers.put(key, new MediaControllerRegistration(controller, callback));
                }
            }
            if (duplicate) {
                try { controller.unregisterCallback(callback); } catch (Throwable ignored) {}
            }
        } catch (Throwable ignored) {
            synchronized (registeredMediaControllers) {
                registeredMediaControllers.remove(key);
            }
        }
    }

    private Object mediaControllerKey(MediaController controller) {
        if (controller == null) return "";
        try {
            Object token = controller.getSessionToken();
            if (token != null) return token;
        } catch (Throwable ignored) {}
        return safeString(controller.getPackageName()) + "@" + System.identityHashCode(controller);
    }

    private void cleanupStaleMediaControllerCallbacks(java.util.Set<Object> activeKeys) {
        java.util.ArrayList<MediaControllerRegistration> stale = new java.util.ArrayList<>();
        synchronized (registeredMediaControllers) {
            java.util.Iterator<java.util.Map.Entry<Object, MediaControllerRegistration>> iterator =
                    registeredMediaControllers.entrySet().iterator();
            while (iterator.hasNext()) {
                java.util.Map.Entry<Object, MediaControllerRegistration> entry = iterator.next();
                if (!activeKeys.contains(entry.getKey())) {
                    stale.add(entry.getValue());
                    iterator.remove();
                }
            }
        }
        for (MediaControllerRegistration registration : stale) {
            registration.unregister();
        }
    }

    private void unregisterMediaControllerCallback(Object key) {
        MediaControllerRegistration registration;
        synchronized (registeredMediaControllers) {
            registration = registeredMediaControllers.remove(key);
        }
        if (registration != null) registration.unregister();
    }

    private void refreshMediaFromControllers(List<MediaController> controllers) {
        try {
            lastMediaValidationAt = System.currentTimeMillis();
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
                clearMediaInfo();
                return;
            }
            String pkg = playing.getPackageName();
            mediaPlaying = true;
            mediaPackage = safeString(pkg);
            mediaApp = safeString(resolveAppLabel(pkg));
            PlaybackState state = playing.getPlaybackState();
            mediaState = safeString(playbackStateName(state));
            mediaTitle = "";
            mediaArtist = "";
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
            clearMediaInfo();
            logDebug("refresh media failed: " + t.getClass().getSimpleName());
        }
    }

    private void refreshActiveMediaState() {
        try {
            if (mediaSessionManager == null) {
                clearMediaInfo();
                return;
            }
            refreshMediaFromControllers(mediaSessionManager.getActiveSessions(null));
        } catch (Throwable ignored) {
            clearMediaInfo();
        }
    }

    private void validateMediaStateIfNeeded(long now) {
        if (!directUploadMedia) return;
        if (!mediaPlaying && mediaPackage.length() == 0 && mediaState.length() == 0) return;
        if (now - lastMediaValidationAt < MEDIA_VALIDATE_MS) return;
        refreshActiveMediaState();
    }

    private void clearMediaInfo() {
        mediaPlaying = false;
        mediaPackage = "";
        mediaApp = "";
        mediaTitle = "";
        mediaArtist = "";
        mediaState = "";
    }

    private String mediaInfoKey() {
        return mediaPlaying + "|" + mediaPackage + "|" + mediaApp + "|" + mediaTitle + "|" + mediaArtist + "|" + mediaState;
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
            if (setTitleText != null) {
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
                                publishBrowserTitle((Activity) owner, packageName, title.toString(), "activity");
                            }
                            return result;
                        });
            }

            // Hook 2: Activity#setTitle(int)
            Method setTitleRes = findMethod(activity, "setTitle", int.class);
            if (setTitleRes != null) {
                try { deoptimize(setTitleRes); } catch (Throwable ignored) {}
                hook(setTitleRes)
                        .setExceptionMode(XposedInterface.ExceptionMode.PROTECTIVE)
                        .intercept(chain -> {
                            Object result = chain.proceed();
                            Object owner = chain.getThisObject();
                            if (owner instanceof Activity) {
                                CharSequence title = ((Activity) owner).getTitle();
                                if (title != null) publishBrowserTitle((Activity) owner, packageName, title.toString(), "activity");
                            }
                            return result;
                        });
            }

            // Hook 3: Activity#setTaskDescription — browsers set page title here
            Class<?> taskDescription = cachedClassForName("android.app.ActivityManager$TaskDescription", cl);
            if (taskDescription != null) {
                Method setTaskDesc = findMethod(activity, "setTaskDescription", taskDescription);
                if (setTaskDesc != null) {
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
                                            publishBrowserTitle((Activity) owner, packageName, label.toString(), "task");
                                        }
                                    }
                                } catch (Throwable ignored) {}
                                return result;
                            });
                }
            }

            // Hook 4: Activity#onWindowFocusChanged
            Method focusChanged = findMethod(activity, "onWindowFocusChanged", boolean.class);
            if (focusChanged != null) {
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
                                if (title != null) publishBrowserTitle((Activity) owner, packageName, title.toString(), "focus");
                            }
                            return result;
                        });
            }

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
                                        publishBrowserTitle(activityCtx, packageName, title, "window");
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
                                        publishBrowserTitle(activityCtx, packageName, title, "webchrome");
                                    } else {
                                        // WebView context is not an Activity — use it directly as send context
                                        Context sendCtx = ctx instanceof Context ? (Context) ctx : null;
                                        publishBrowserTitleFromProcess(sendCtx, packageName, title, "", "webchrome");
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
            hookWebViewClientPageFinished(cl, webView, packageName);
            hookWebViewClientTitleEvent(cl, webView, packageName, "onPageCommitVisible", webView, String.class);
            hookWebViewClientTitleEvent(cl, webView, packageName, "doUpdateVisitedHistory", webView, String.class, boolean.class);
            hookWebViewClientTitleEvent(cl, webView, packageName, "shouldOverrideUrlLoading", webView, String.class);
            Class<?> webResourceRequest = cachedClassForName("android.webkit.WebResourceRequest", cl);
            if (webResourceRequest != null) {
                hookWebViewClientTitleEvent(cl, webView, packageName, "shouldOverrideUrlLoading", webView, webResourceRequest);
            }
            hookWebChromeProgress(cl, webView, packageName);
            hookWebViewClientInstallers(webView, packageName);
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
                                publishTitleFromWebView(args.get(0), packageName, (String) args.get(1), "webchrome");
                            }
                        } catch (Throwable ignored) {}
                        return result;
                    });
            log(Log.INFO, TAG, "hooked concrete WebChromeClient#onReceivedTitle: " + className);
        } catch (Throwable ignored) {}
        hookSpecificWebChromeProgress(clientClass, webView, packageName);
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
        hookSpecificWebViewClientTitleEvent(clientClass, webView, packageName, "onPageCommitVisible", webView, String.class);
        hookSpecificWebViewClientTitleEvent(clientClass, webView, packageName, "doUpdateVisitedHistory", webView, String.class, boolean.class);
        hookSpecificWebViewClientTitleEvent(clientClass, webView, packageName, "shouldOverrideUrlLoading", webView, String.class);
        Class<?> request = cachedClassForName("android.webkit.WebResourceRequest", webView.getClassLoader());
        if (request != null) {
            hookSpecificWebViewClientTitleEvent(clientClass, webView, packageName, "shouldOverrideUrlLoading", webView, request);
        }
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
                                    publishBrowserTitle((Activity) owner, packageName, (String) args.get(1), "aosp");
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
            logDebug("AOSP browser title hooks skipped: " + t.getClass().getSimpleName());
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
        String key = packageName + ":" + System.identityHashCode(webView) + ":" + delayMs;
        try {
            Method postDelayed = findPublicMethod(webView.getClass(), "postDelayed", Runnable.class, long.class);
            if (postDelayed == null) return;
            if (!scheduledWebViewTitleReads.add(key)) return;
            postDelayed.invoke(webView, (Runnable) () -> {
                try {
                    publishTitleFromWebView(webView, packageName);
                } finally {
                    scheduledWebViewTitleReads.remove(key);
                }
            }, delayMs);
        } catch (Throwable ignored) {
            scheduledWebViewTitleReads.remove(key);
        }
    }

    private void publishTitleFromWebView(Object webView, String packageName) {
        publishTitleFromWebView(webView, packageName, "", "webview");
    }

    private void publishTitleFromWebView(Object webView, String packageName, String explicitTitle) {
        publishTitleFromWebView(webView, packageName, explicitTitle, "webview");
    }

    private void publishTitleFromWebView(Object webView, String packageName, String explicitTitle, String source) {
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
                publishBrowserTitle(activityCtx, packageName, title, source);
            } else {
                publishBrowserTitleFromProcess(ctx instanceof Context ? (Context) ctx : null, packageName, title, "", source);
            }
        } catch (Throwable ignored) {}
    }

    private void hookWebViewClientTitleEvent(ClassLoader cl, Class<?> webView, String packageName, String methodName, Class<?>... paramTypes) {
        try {
            Class<?> viewClient = cachedClassForName("android.webkit.WebViewClient", cl);
            if (viewClient == null) throw new ClassNotFoundException("android.webkit.WebViewClient");
            hookSpecificWebViewClientTitleEvent(viewClient, webView, packageName, methodName, paramTypes);
        } catch (Throwable ignored) {}
    }

    private void hookSpecificWebViewClientTitleEvent(Class<?> clientClass, Class<?> webView, String packageName, String methodName, Class<?>... paramTypes) {
        if (clientClass == null) return;
        String className = clientClass.getName();
        String hookKey = packageName + ":" + className + ":" + methodName + ":" + paramTypes.length;
        if (!hookedWebViewClientClasses.add(hookKey)) return;
        Method method = findMethod(clientClass, methodName, paramTypes);
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
                                scheduleWebViewTitleRead(args.get(0), packageName, 120L);
                                scheduleWebViewTitleRead(args.get(0), packageName, 650L);
                                scheduleWebViewTitleRead(args.get(0), packageName, 1800L);
                            }
                        } catch (Throwable ignored) {}
                        return result;
                    });
            log(Log.INFO, TAG, "hooked WebViewClient#" + methodName + ": " + className);
        } catch (Throwable ignored) {}
    }

    private void hookWebChromeProgress(ClassLoader cl, Class<?> webView, String packageName) {
        try {
            Class<?> chromeClient = cachedClassForName("android.webkit.WebChromeClient", cl);
            if (chromeClient == null) throw new ClassNotFoundException("android.webkit.WebChromeClient");
            hookSpecificWebChromeProgress(chromeClient, webView, packageName);
        } catch (Throwable ignored) {}
    }

    private void hookSpecificWebChromeProgress(Class<?> clientClass, Class<?> webView, String packageName) {
        if (clientClass == null) return;
        String className = clientClass.getName();
        String hookKey = packageName + ":" + className + ":onProgressChanged";
        if (!hookedWebChromeClientClasses.add(hookKey)) return;
        Method method = findMethod(clientClass, "onProgressChanged", webView, int.class);
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
                            int progress = args.size() > 1 && args.get(1) instanceof Integer ? (Integer) args.get(1) : 0;
                            if (args.size() > 0 && progress >= 70) {
                                scheduleWebViewTitleRead(args.get(0), packageName, progress >= 100 ? 80L : 500L);
                                if (progress >= 100) scheduleWebViewTitleRead(args.get(0), packageName, 900L);
                            }
                        } catch (Throwable ignored) {}
                        return result;
                    });
            log(Log.INFO, TAG, "hooked WebChromeClient#onProgressChanged: " + className);
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
        publishBrowserTitle(activity, packageName, title, "activity");
    }

    private void publishBrowserTitle(Activity activity, String packageName, String title, String source) {
        try {
            String clean = cleanTitle(title);
            if (clean == null || isIgnoredPackage(packageName)) return;
            if (isGenericBrowserTitle(packageName, clean) && !isWebTitleSource(source)) return;
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
            publishBrowserTitleFromProcess(sendContext, packageName, clean, activity.getClass().getName(), source);
        } catch (Throwable t) {
            logDebug("publishBrowserTitle failed: " + t.getMessage());
        }
    }

    private void publishBrowserTitleFromProcess(Context context, String packageName, String title, String activityName) {
        publishBrowserTitleFromProcess(context, packageName, title, activityName, "activity");
    }

    private void publishBrowserTitleFromProcess(Context context, String packageName, String title, String activityName, String source) {
        try {
            if (context == null) context = getSystemContext();
            if (context == null) return;
            String clean = cleanTitle(title);
            if (clean == null || isIgnoredPackage(packageName)) return;
            boolean genericTitle = isGenericBrowserTitle(packageName, clean);
            if (genericTitle && !isWebTitleSource(source)) return;
            Intent intent = new Intent(ACTION_BROWSER_TITLE);
            intent.putExtra("package_name", packageName);
            intent.putExtra("title", clean);
            intent.putExtra("activity", safeString(activityName));
            intent.putExtra("source", safeString(source));
            if (genericTitle) intent.putExtra("clear_title", true);
            String nonce = getBrowserTitleNonce(false);
            if (nonce.length() > 0) {
                intent.putExtra(KEY_BROWSER_TITLE_NONCE, nonce);
            }
            // Send broadcast using browser's own context (Activity/ApplicationContext).
            // getSentFromPackage() on API 34+ will return the browser's package because
            // we're sending from the browser's own Context, not system_server's.
            if (Build.VERSION.SDK_INT >= 34) {
                BroadcastOptions options = BroadcastOptions.makeBasic();
                options.setShareIdentityEnabled(true);
                context.sendBroadcast(intent, null, options.toBundle());
            } else {
                context.sendBroadcast(intent);
            }
        } catch (Throwable t) {
            logDebug("publishBrowserTitleFromProcess failed: " + t.getMessage());
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
                applyForegroundTitle("", "sleep");
                log(Log.INFO, TAG, "screen off → sleeping");
                forceDirectUpload = true;
                Intent sleepIntent = new Intent(ACTION_STATUS);
                sleepIntent.setComponent(new ComponentName(TARGET_PACKAGE, TARGET_RECEIVER));
                sleepIntent.putExtra("package_name", "sleeping");
                sleepIntent.putExtra("app_name", "sleeping");
                sleepIntent.putExtra("activity", "");
                putMediaExtras(sleepIntent);
                Context ctx = getSystemContext();
                if (ctx != null) {
                    long token = Binder.clearCallingIdentity();
                    try { ctx.sendBroadcast(sleepIntent, CONFIG_PERMISSION); } finally { Binder.restoreCallingIdentity(token); }
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
                applyForegroundTitle("", "idle");
            } else {
                idleConsecutiveCount = 0; // reset on valid foreground
                String packageName = top.getPackageName();
                String activityName = top.getClassName();
                String key = packageName + "/" + activityName;
                if (!key.equals(lastForegroundKey)) {
                    logDebug("foreground: " + key + " title=" + (taskDescription != null ? taskDescription : ""));
                    forceDirectUpload = true;
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
                    String browserTitle = cleanBrowserTitle(packageName, taskDescription);
                    if (browserTitle != null) {
                        if (shouldApplyBrowserTitleCandidate(packageName, browserTitle, "task")) {
                            applyForegroundTitle(browserTitle, "task");
                        }
                    } else if (isGenericBrowserTitle(packageName, taskDescription)) {
                        applyForegroundTitle("", "task");
                    }
                } else if (!isBrowserPackage(packageName)) {
                    applyForegroundTitle("", "foreground");
                }
                // else: keep previous title if browser package and no new description
            }

            maybeApplySupervisionFreeze(foregroundPackage, foregroundApp, foregroundTitle);

            Intent intent = new Intent(ACTION_STATUS);
            intent.setComponent(new ComponentName(TARGET_PACKAGE, TARGET_RECEIVER));
            if (idleCandidate) {
                intent.putExtra("package_name", "idle");
                intent.putExtra("app_name", "idle");
                intent.putExtra("activity", "");
            } else {
                intent.putExtra("package_name", foregroundPackage);
                intent.putExtra("app_name", foregroundApp);
                intent.putExtra("activity", foregroundActivity);
                if (foregroundTitle.length() > 0 || isBrowserPackage(foregroundPackage)) {
                    intent.putExtra("title", foregroundTitle);
                }
            }
            putMediaExtras(intent);
            Context context = getSystemContext();
            if (context != null) {
                long token = Binder.clearCallingIdentity();
                try { context.sendBroadcast(intent, CONFIG_PERMISSION); } finally { Binder.restoreCallingIdentity(token); }
            }
            maybeDirectUpload(forceDirectUpload);
        } catch (Throwable t) {
            log(Log.WARN, TAG, "broadcast failed: " + t.getClass().getSimpleName());
        }
    }

    private void putMediaExtras(Intent intent) {
        intent.putExtra(EXTRA_MEDIA_PLAYING, mediaPlaying);
        if (mediaPackage.length() > 0) intent.putExtra(EXTRA_MEDIA_PACKAGE, mediaPackage);
        if (mediaTitle.length() > 0) intent.putExtra(EXTRA_MEDIA_TITLE, mediaTitle);
        if (mediaArtist.length() > 0) intent.putExtra(EXTRA_MEDIA_ARTIST, mediaArtist);
        if (mediaApp.length() > 0) intent.putExtra(EXTRA_MEDIA_APP, mediaApp);
        if (mediaState.length() > 0) intent.putExtra(EXTRA_MEDIA_STATE, mediaState);
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
            logDebug("getTasks top fallback failed: " + t.getClass().getSimpleName());
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
                    logDebug("getTasks fallback skipped: " + t.getClass().getSimpleName());
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
            logDebug("getFocusedTaskDescription skipped: " + t.getClass().getSimpleName());
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

    private boolean isSystemServerProcess() {
        if (systemServerProcess) return true;
        String process = currentProcessName;
        return "system".equals(process)
                || "system_server".equals(process)
                || "android".equals(process);
    }

    private void logDebug(String message) {
        if (BuildConfig.DEBUG) {
            log(Log.DEBUG, TAG, message);
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
                            .getSharedPreferences(PREFS_DIRECT_UPLOAD, Context.MODE_PRIVATE);
                    if (dps.contains("enabled")) {
                        directUploadEnabled = dps.getBoolean("enabled", false);
                        directServerUrl = dps.getString("server_url", "");
                        directToken = dps.getString("token", "");
                        directIntervalMs = clampDirectInterval(dps.getLong("interval_ms", 30000L));
                        directUploadForeground = dps.getBoolean("upload_foreground", true);
                        directUploadMedia = dps.getBoolean("upload_media", true);
                        directUploadNetwork = dps.getBoolean("upload_network", true);
                        directUploadVpn = dps.getBoolean("upload_vpn", false);
                        browserTitleNonce = normalizeNonce(dps.getString(KEY_BROWSER_TITLE_NONCE, ""));
                        pendingDirectBody = safeString(dps.getString(KEY_PENDING_DIRECT_BODY, ""));
                        logDebug("config loaded from DPS: enabled=" + directUploadEnabled);
                        return;
                    }
                } catch (Throwable ignored) {}
            }
            // Priority 2: Fallback to getRemotePreferences
            SharedPreferences prefs = getRemotePreferences(PREFS_DIRECT_UPLOAD);
            directUploadEnabled = prefs.getBoolean("enabled", false);
            directServerUrl = prefs.getString("server_url", "");
            directToken = prefs.getString("token", "");
            directIntervalMs = clampDirectInterval(prefs.getLong("interval_ms", 30000L));
            directUploadForeground = prefs.getBoolean("upload_foreground", true);
            directUploadMedia = prefs.getBoolean("upload_media", true);
            directUploadNetwork = prefs.getBoolean("upload_network", true);
            directUploadVpn = prefs.getBoolean("upload_vpn", false);
            browserTitleNonce = normalizeNonce(prefs.getString(KEY_BROWSER_TITLE_NONCE, ""));
            pendingDirectBody = safeString(prefs.getString(KEY_PENDING_DIRECT_BODY, ""));
            logDebug("config loaded from remote prefs: enabled=" + directUploadEnabled);
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
            String incomingBrowserTitleNonce = normalizeNonce(intent.getStringExtra(KEY_BROWSER_TITLE_NONCE));
            if (incomingBrowserTitleNonce.length() == 0) incomingBrowserTitleNonce = browserTitleNonce;

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
                        .getSharedPreferences(PREFS_DIRECT_UPLOAD, Context.MODE_PRIVATE);
                prefs.edit()
                        .putBoolean("enabled", enabled)
                        .putString("server_url", serverUrl)
                        .putString("token", token)
                        .putLong("interval_ms", clampDirectInterval(intervalSec * 1000L))
                        .putBoolean("upload_foreground", uploadForeground)
                        .putBoolean("upload_media", uploadMedia)
                        .putBoolean("upload_network", uploadNetwork)
                        .putBoolean("upload_vpn", uploadVpn)
                        .putBoolean("upload_input", false)
                        .putString(KEY_BROWSER_TITLE_NONCE, incomingBrowserTitleNonce)
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
            browserTitleNonce = incomingBrowserTitleNonce;
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
        if (!isSystemServerProcess()) return;
        long now = System.currentTimeMillis();
        long safeInterval = Math.max(MIN_DIRECT_UPLOAD_MS, directIntervalMs);
        if (!force && now - lastDirectUploadAt < safeInterval) return;
        lastDirectUploadAt = now;

        // Use dedicated upload HandlerThread (single background thread, no unbounded spawning).
            final String url = directServerUrl;
            final String tok = directToken;
            final long sampleAt = now;
            final boolean forceRequested = force;
            Handler handler = getUploadHandler();
        if (handler == null) {
            log(Log.WARN, TAG, "upload skipped: background handler unavailable");
            return;
        }
        handler.post(() -> {
            final String body = buildDirectReportBody(sampleAt, forceRequested);
            if (body == null) return;

            // Diagnostic log: show what we're about to upload
            try {
                org.json.JSONObject diag = new org.json.JSONObject(body);
                logDebug("upload: app_id=" + diag.optString("app_id") + " title=" + diag.optString("window_title"));
            } catch (Throwable ignored) {}

            String pending = pendingDirectBody;
            if (pending.length() > 0 && !pending.equals(body)) {
                if (sendDirectReport(url, tok, pending)) {
                    setPendingDirectBody("");
                } else {
                    return;
                }
            }
            if (sendDirectReport(url, tok, body)) {
                if (body.equals(pendingDirectBody)) setPendingDirectBody("");
            } else {
                setPendingDirectBody(body);
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
                    logDebug("ws upload OK");
                    return true;
                }
            } catch (Throwable t) {
                log(Log.WARN, TAG, "ws send failed: " + t.getClass().getSimpleName());
            }
        }
        boolean ok = postDirectReportFallback(body);
        if (ok) {
            logDebug("http fallback upload OK");
        } else {
            log(Log.WARN, TAG, "http fallback upload failed");
        }
        return ok;
    }

    private long clampDirectInterval(long intervalMs) {
        return Math.max(MIN_DIRECT_UPLOAD_MS, Math.min(MAX_DIRECT_UPLOAD_MS, intervalMs));
    }

    private String buildDirectReportBody(long now, boolean forceRequested) {
        try {
            validateMediaStateIfNeeded(now);
            String appId = directUploadForeground ? safeString(foregroundPackage) : "";
            boolean foregroundCanYieldToMedia = appId.length() == 0 || "idle".equals(appId) || "sleeping".equals(appId);
            if (foregroundCanYieldToMedia) {
                // When idle/sleeping but media is playing, use the media package as app_id.
                // Avoids displaying idle/sleeping as the active app when user is listening.
                if (directUploadMedia && mediaPlaying && mediaPackage.length() > 0) {
                    appId = mediaPackage;
                } else if (appId.length() == 0) {
                    appId = "idle";
                }
            }
            String windowTitle = primaryDisplayTitle();
            JSONObject extra = new JSONObject();
            fillBatteryExtras(extra);
            JSONObject device = new JSONObject();
            boolean sleeping = "sleeping".equals(foregroundPackage);
            device.put("capability_mode", "lsposed");
            device.put("uploader", "lsposed");
            device.put("last_sample_at", isoTime(now));
            device.put("energy_policy", "system_server_direct");
            device.put("min_interval_ms", Math.max(MIN_DIRECT_UPLOAD_MS, directIntervalMs));
            if (sleeping) {
                device.put(OFFLINE_TIMEOUT_FIELD, directOfflineTimeoutMinutes());
            }
            if (shouldRequestSupervisionCheck(now, windowTitle)) {
                device.put("supervision_check_requested", true);
            }
            // Multi-window / tablet detection
            device.put("device_kind", getDeviceFormFactor());
            String wm = getWindowingMode();
            if (wm != null) device.put("window_mode", wm);
            fillNetworkExtras(device);
            fillAudioOutputExtras(device);
            fillAmbientLightExtras(device, now);
            if (shouldSendDirectHeartbeatOnly(now, forceRequested)) {
                device.put("heartbeat_only", true);
            }
            JSONArray frozen = frozenPackagesJson(now);
            if (frozen.length() > 0) device.put("frozen_packages", frozen);
            extra.put("device", device);
            extra.put("sleeping", sleeping);
            if (directUploadForeground && foregroundPackage.length() > 0 && !"idle".equals(foregroundPackage)) {
                JSONObject foreground = new JSONObject();
                foreground.put("package_name", foregroundPackage);
                if (foregroundApp.length() > 0) foreground.put("app_name", foregroundApp);
                if (foregroundActivity.length() > 0) foreground.put("activity", foregroundActivity);
                if (foregroundTitle.length() > 0 || isBrowserPackage(foregroundPackage)) {
                    foreground.put("title", foregroundTitle);
                }
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

    private boolean shouldRequestSupervisionCheck(long now, String windowTitle) {
        try {
            if (!directUploadForeground) return false;
            String pkg = safeString(foregroundPackage);
            if (pkg.length() == 0 || "idle".equals(pkg) || "sleeping".equals(pkg)) return false;
            if (isProtectedFreezePackage(pkg)) return false;

            String key = pkg + "|" + safeString(foregroundApp) + "|" + safeString(windowTitle);
            long elapsed = now - lastSupervisionCheckRequestAt;
            if (elapsed >= 0 && elapsed < SUPERVISION_CHECK_REQUEST_MIN_MS) return false;
            if (key.equals(lastSupervisionCheckRequestKey)
                    && elapsed >= 0
                    && elapsed < SUPERVISION_CHECK_REQUEST_SAME_KEY_MS) {
                return false;
            }
            lastSupervisionCheckRequestAt = now;
            lastSupervisionCheckRequestKey = key;
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private int directOfflineTimeoutMinutes() {
        long cadenceMs = Math.max(HEARTBEAT_MS, Math.max(MIN_DIRECT_UPLOAD_MS, directIntervalMs));
        long cadenceMinutes = Math.max(1L, (cadenceMs + 59_999L) / 60_000L);
        long timeoutMinutes = cadenceMinutes + REPORTED_OFFLINE_TIMEOUT_GRACE_MINUTES;
        return (int) Math.min(MAX_REPORTED_OFFLINE_TIMEOUT_MINUTES, timeoutMinutes);
    }

    private long nextDailyUnfreezeAt(long now) {
        java.util.Calendar calendar = java.util.Calendar.getInstance();
        calendar.setTimeInMillis(now);
        calendar.set(java.util.Calendar.HOUR_OF_DAY, SUPERVISION_DAILY_UNFREEZE_HOUR);
        calendar.set(java.util.Calendar.MINUTE, 0);
        calendar.set(java.util.Calendar.SECOND, 0);
        calendar.set(java.util.Calendar.MILLISECOND, 0);
        if (calendar.getTimeInMillis() <= now) {
            calendar.add(java.util.Calendar.DAY_OF_YEAR, 1);
        }
        return calendar.getTimeInMillis();
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
            logDebug("battery extras skipped: " + t.getClass().getSimpleName());
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
            logDebug("network extras skipped: " + t.getClass().getSimpleName());
        }
    }

    private void fillAudioOutputExtras(JSONObject device) {
        try {
            Context ctx = getSystemContext();
            if (ctx == null) return;
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            AudioCandidate best = null;
            AudioDeviceInfo[] devices = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
            if (devices != null) {
                for (AudioDeviceInfo info : devices) {
                    AudioCandidate candidate = audioCandidate(info);
                    if (candidate != null && (best == null || candidate.priority > best.priority)) {
                        best = candidate;
                    }
                }
            }
            if (best != null) {
                device.put("audio_output_connected", true);
                device.put("audio_output_type", best.type);
                if (best.name.length() > 0) device.put("audio_output_name", best.name);
            } else {
                device.put("audio_output_connected", false);
                device.put("audio_output_type", "speaker");
            }
        } catch (Throwable t) {
            logDebug("audio output skipped: " + t.getClass().getSimpleName());
        }
    }

    private AudioCandidate audioCandidate(AudioDeviceInfo info) {
        if (info == null) return null;
        String name = "";
        try {
            CharSequence productName = info.getProductName();
            if (productName != null) name = safeString(productName.toString());
        } catch (Throwable ignored) {}
        switch (info.getType()) {
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
                return new AudioCandidate("bluetooth_headset", name, 90);
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                return new AudioCandidate("wired_headset", name, 80);
            case AudioDeviceInfo.TYPE_USB_HEADSET:
            case AudioDeviceInfo.TYPE_USB_DEVICE:
                return new AudioCandidate("usb_audio", name, 70);
            case AudioDeviceInfo.TYPE_HEARING_AID:
                return new AudioCandidate("hearing_aid", name, 65);
            case AudioDeviceInfo.TYPE_HDMI:
            case AudioDeviceInfo.TYPE_HDMI_ARC:
            case AudioDeviceInfo.TYPE_HDMI_EARC:
                return new AudioCandidate("hdmi_audio", name, 50);
            default:
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    int type = info.getType();
                    if (type == AudioDeviceInfo.TYPE_BLE_HEADSET ||
                            type == AudioDeviceInfo.TYPE_BLE_SPEAKER ||
                            type == AudioDeviceInfo.TYPE_BLE_BROADCAST) {
                        return new AudioCandidate("bluetooth_headset", name, 85);
                    }
                }
                return null;
        }
    }

    private void fillAmbientLightExtras(JSONObject device, long now) {
        try {
            if (lastAmbientLux >= 0f && now - lastAmbientLightAt <= AMBIENT_LIGHT_CACHE_MS) {
                device.put("ambient_lux", Math.round(lastAmbientLux * 10f) / 10.0);
            }
            requestAmbientLightSample();
        } catch (Throwable t) {
            logDebug("ambient light skipped: " + t.getClass().getSimpleName());
        }
    }

    private void requestAmbientLightSample() {
        if (ambientLightListenerRegistered) return;
        try {
            Context ctx = getSystemContext();
            if (ctx == null) return;
            SensorManager sm = (SensorManager) ctx.getSystemService(Context.SENSOR_SERVICE);
            if (sm == null) return;
            Sensor sensor = sm.getDefaultSensor(Sensor.TYPE_LIGHT);
            if (sensor == null) return;
            Handler handler = getUploadHandler();
            if (handler == null) return;
            final SensorEventListener[] holder = new SensorEventListener[1];
            holder[0] = new SensorEventListener() {
                @Override
                public void onSensorChanged(SensorEvent event) {
                    try {
                        if (event != null && event.values != null && event.values.length > 0) {
                            lastAmbientLux = Math.max(0f, Math.min(200000f, event.values[0]));
                            lastAmbientLightAt = System.currentTimeMillis();
                        }
                    } catch (Throwable ignored) {
                    } finally {
                        try { sm.unregisterListener(holder[0]); } catch (Throwable ignored) {}
                        ambientLightListenerRegistered = false;
                    }
                }

                @Override
                public void onAccuracyChanged(Sensor sensor, int accuracy) {}
            };
            if (sm.registerListener(holder[0], sensor, SensorManager.SENSOR_DELAY_NORMAL, handler)) {
                ambientLightListenerRegistered = true;
                handler.postDelayed(() -> {
                    try {
                        if (ambientLightListenerRegistered) {
                            sm.unregisterListener(holder[0]);
                            ambientLightListenerRegistered = false;
                        }
                    } catch (Throwable ignored) {}
                }, 1000L);
            }
        } catch (Throwable ignored) {
            ambientLightListenerRegistered = false;
        }
    }

    private boolean shouldSendDirectHeartbeatOnly(long now, boolean forceRequested) {
        String signature = directStateSignature();
        if (forceRequested || signature.length() == 0 || !signature.equals(lastDirectStateSignature)) {
            lastDirectStateSignature = signature;
            lastDirectFullReportAt = now;
            return false;
        }
        if (lastDirectFullReportAt <= 0L || now - lastDirectFullReportAt >= DIRECT_FULL_STATE_INTERVAL_MS) {
            lastDirectFullReportAt = now;
            return false;
        }
        return true;
    }

    private String directStateSignature() {
        return safeString(foregroundPackage) + "|" +
                safeString(foregroundTitle) + "|" +
                safeString(mediaPackage) + "|" +
                safeString(mediaTitle) + "|" +
                mediaPlaying + "|" +
                safeString(mediaState);
    }

    private void setPendingDirectBody(String body) {
        String safeBody = safeString(body);
        pendingDirectBody = safeBody;
        try {
            Context ctx = getSystemContext();
            if (ctx == null) return;
            SharedPreferences prefs = ctx.createDeviceProtectedStorageContext()
                    .getSharedPreferences(PREFS_DIRECT_UPLOAD, Context.MODE_PRIVATE);
            prefs.edit().putString(KEY_PENDING_DIRECT_BODY, safeBody).apply();
        } catch (Throwable ignored) {}
    }

    private static final class AudioCandidate {
        final String type;
        final String name;
        final int priority;

        AudioCandidate(String type, String name, int priority) {
            this.type = safeStatic(type);
            this.name = safeStatic(name);
            this.priority = priority;
        }

        private static String safeStatic(String value) {
            if (value == null) return "";
            String trimmed = value.trim();
            return trimmed.length() > 64 ? trimmed.substring(0, 64) : trimmed;
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

    @SuppressLint("MissingPermission")
    private String cellularGeneration() {
        try {
            Context ctx = getSystemContext();
            if (ctx == null) return "";
            TelephonyManager tm = (TelephonyManager) ctx.getSystemService(Context.TELEPHONY_SERVICE);
            if (tm == null) return "";
            if (!hasPhoneStatePermission(ctx)) return "";
            int dataNetworkType;
            try {
                dataNetworkType = tm.getDataNetworkType();
            } catch (SecurityException ignored) {
                return "";
            }
            switch (dataNetworkType) {
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

    private boolean hasPhoneStatePermission(Context ctx) {
        try {
            if (ctx.checkSelfPermission(android.Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED) {
                return true;
            }
            return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                    && ctx.checkSelfPermission(android.Manifest.permission.READ_BASIC_PHONE_STATE) == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable ignored) {
            return false;
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
                logDebug("http upload OK");
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
                logDebug("message fallback fetch HTTP " + code);
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
                Object payload = item.opt("payload");
                if (payload instanceof JSONObject) {
                    data.put("payload", payload);
                } else if (payload instanceof String && ((String) payload).length() > 0) {
                    try { data.put("payload", new JSONObject((String) payload)); } catch (Throwable ignored) {}
                }
                forwardViewerMessageToApp(data.toString());
            }
            logDebug("message fallback fetch delivered " + messages.length());
        } catch (Throwable t) {
            logDebug("message fallback fetch skipped: " + t.getClass().getSimpleName());
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
        if (!directUploadEnabled || !isSystemServerProcess()) return;
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
        if (!directUploadEnabled || directServerUrl.length() == 0 || directToken.length() == 0 || !isSystemServerProcess()) return;
        if (wsReconnectPending) return;
        wsReconnectPending = true;
        long delayMs = 0L;
        long lastFail = wsLastFailAt;
        if (lastFail > 0) {
            delayMs = Math.max(0L, wsRetryDelayMs - (System.currentTimeMillis() - lastFail));
        }
        // Reconnect and immediately send the current snapshot. Reconnecting alone
        // would leave the dashboard stale until the next 5-minute heartbeat.
        Handler handler = getUploadHandler();
        if (handler == null) {
            wsReconnectPending = false;
            return;
        }
        handler.postDelayed(() -> {
            wsReconnectPending = false;
            maybeDirectUpload(true);
        }, delayMs);
    }

    private void recordWsDisconnectedForBackoff() {
        long now = System.currentTimeMillis();
        synchronized (this) {
            if (wsRetryDelayMs < WS_RETRY_BASE_MS) wsRetryDelayMs = WS_RETRY_BASE_MS;
            if (wsLastFailAt <= 0 || now - wsLastFailAt >= wsRetryDelayMs) {
                wsLastFailAt = now;
            }
        }
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
            JSONObject payload = data.optJSONObject("payload");
            if (payload != null) intent.putExtra("payload", payload.toString());
            handleSupervisionPayload(payload, text);
            Context ctx = getSystemContext();
            if (ctx != null) {
                long token = Binder.clearCallingIdentity();
                try {
                    ctx.sendBroadcast(intent, CONFIG_PERMISSION);
                    if (!isSupervisionPayload(data)) {
                        postViewerMessageNotification(ctx, data, text, viewerId);
                    }
                } finally {
                    Binder.restoreCallingIdentity(token);
                }
                logDebug("forwarded viewer message to app: " + viewerId);
            }
        } catch (Throwable t) {
            logDebug("viewer message forward ignored: " + t.getClass().getSimpleName());
        }
    }

    private boolean isSupervisionPayload(JSONObject data) {
        try {
            JSONObject payload = data.optJSONObject("payload");
            return payload != null && "supervision_alert".equals(payload.optString("type"));
        } catch (Throwable ignored) {
            return false;
        }
    }

    private void handleSupervisionPayload(JSONObject payload, String text) {
        try {
            if (payload == null || !"supervision_alert".equals(payload.optString("type"))) return;
            if (strictBoolean(payload, "unfreeze", false)) {
                handleSupervisionUnfreezePayload(payload, text);
                return;
            }
            if (!strictBoolean(payload, "freeze", false)) {
                activeFreezeAlert = null;
                return;
            }
            long now = System.currentTimeMillis();
            long activeUntil = parseIsoMillis(payload.optString("active_until"), now + SUPERVISION_DEFAULT_FREEZE_MS);
            long payloadFreezeUntil = parseIsoMillis(payload.optString("freeze_until"), now + SUPERVISION_DEFAULT_FREEZE_MS);
            if (activeUntil <= now || payloadFreezeUntil <= now) {
                activeFreezeAlert = null;
                return;
            }
            long freezeUntil = nextDailyUnfreezeAt(now);
            java.util.List<java.util.regex.Pattern> patterns = compileSafePatterns(payload.optJSONArray("violation_regex"));
            if (patterns.isEmpty()) {
                activeFreezeAlert = null;
                return;
            }
            java.util.List<java.util.regex.Pattern> recoveryPatterns = compileSafePatterns(payload.optJSONArray("recovery_regex"));
            activeFreezeAlert = new SupervisionFreezeAlert(
                    payload.optString("alert_id", "supervision"),
                    patterns,
                    recoveryPatterns,
                    activeUntil,
                    freezeUntil,
                    safeString(payload.optString("reason", text)));
            log(Log.INFO, TAG, "supervision freeze armed until " + isoTime(freezeUntil));
            forceForegroundSnapshot();
            maybeApplySupervisionFreeze(foregroundPackage, foregroundApp, foregroundTitle);
        } catch (Throwable t) {
            logDebug("supervision payload ignored: " + t.getClass().getSimpleName());
        }
    }

    private void handleSupervisionUnfreezePayload(JSONObject payload, String text) {
        try {
            String reason = safeString(payload.optString("reason", text));
            java.util.List<java.util.regex.Pattern> patterns = compileSafePatterns(payload.optJSONArray("unfreeze_regex"));
            if (patterns.isEmpty()) {
                patterns = compileSafePatterns(payload.optJSONArray("recovery_regex"));
            }
            boolean unfreezeAll = strictBoolean(payload, "unfreeze_all", false) || patterns.isEmpty();
            if (unfreezeAll) {
                clearSupervisionFreeze("AI unfreeze: " + reason);
                return;
            }
            int count = unfreezeFrozenPackages(patterns, "AI unfreeze: " + reason);
            if (count > 0) {
                log(Log.WARN, TAG, "supervision unfroze " + count + " package(s) by AI command");
                maybeDirectUpload(true);
            }
        } catch (Throwable t) {
            logDebug("supervision unfreeze ignored: " + t.getClass().getSimpleName());
        }
    }

    private void maybeApplySupervisionFreeze(String packageName, String appName, String title) {
        try {
            SupervisionFreezeAlert alert = activeFreezeAlert;
            if (alert == null) return;
            long now = System.currentTimeMillis();
            if (now > alert.activeUntil || now > alert.freezeUntil) {
                activeFreezeAlert = null;
                cleanupFrozenPackages(now);
                return;
            }
            String pkg = safeString(packageName);
            if (pkg.length() == 0 || isProtectedFreezePackage(pkg)) return;
            String matchText = pkg + " " + safeString(appName) + " " + safeString(title);
            if (matchesAny(alert.recoveryPatterns, matchText)) {
                clearSupervisionFreeze("AI recovery match: " + pkg);
                return;
            }
            FrozenPackageRecord existing = frozenPackages.get(pkg);
            if (existing != null && existing.until > now) return;
            if (!matchesAny(alert.violationPatterns, matchText)) return;
            long until = nextDailyUnfreezeAt(now);
            boolean suspended = setPackageSuspended(pkg, true);
            boolean stopped = forceStopPackage(pkg);
            if (!suspended && !stopped) return;
            frozenPackages.put(pkg, new FrozenPackageRecord(
                    pkg,
                    safeString(appName),
                    now,
                    until,
                    alert.reason,
                    suspended ? "suspended" : "force_stopped"));
            log(Log.WARN, TAG, "supervision froze " + pkg + " mode=" + (suspended ? "suspended" : "force_stopped") + " until " + isoTime(until));
            postSupervisionFreezeNotification(pkg, safeString(appName), alert.reason, until);
            maybeDirectUpload(true);
        } catch (Throwable t) {
            logDebug("supervision freeze skipped: " + t.getClass().getSimpleName());
        }
    }

    private boolean matchesAny(java.util.List<java.util.regex.Pattern> patterns, String text) {
        if (patterns == null || patterns.isEmpty()) return false;
        String value = safeString(text);
        if (value.length() == 0) return false;
        for (java.util.regex.Pattern pattern : patterns) {
            try {
                if (pattern.matcher(value).find()) return true;
            } catch (Throwable ignored) {}
        }
        return false;
    }

    private int unfreezeFrozenPackages(java.util.List<java.util.regex.Pattern> patterns, String reason) {
        int count = 0;
        try {
            for (String pkg : frozenPackages.keySet()) {
                FrozenPackageRecord record = frozenPackages.get(pkg);
                if (record == null) continue;
                if (!matchesFrozenRecord(record, patterns)) continue;
                if ("suspended".equals(record.mode)) setPackageSuspended(record.packageName, false);
                frozenPackages.remove(pkg);
                count++;
            }
            if (frozenPackages.isEmpty()) activeFreezeAlert = null;
            if (count > 0) log(Log.WARN, TAG, safeString(reason));
        } catch (Throwable t) {
            logDebug("supervision unfreeze failed: " + t.getClass().getSimpleName());
        }
        return count;
    }

    private boolean matchesFrozenRecord(FrozenPackageRecord record, java.util.List<java.util.regex.Pattern> patterns) {
        if (record == null) return false;
        String text = safeString(record.packageName) + " " + safeString(record.appName) + " " + safeString(record.reason);
        return matchesAny(patterns, text);
    }

    private void clearSupervisionFreeze(String reason) {
        try {
            activeFreezeAlert = null;
            for (FrozenPackageRecord record : frozenPackages.values()) {
                if ("suspended".equals(record.mode)) setPackageSuspended(record.packageName, false);
            }
            frozenPackages.clear();
            log(Log.WARN, TAG, "supervision freeze cleared: " + safeString(reason));
            maybeDirectUpload(true);
        } catch (Throwable t) {
            logDebug("clear supervision freeze failed: " + t.getClass().getSimpleName());
        }
    }

    private boolean setPackageSuspended(String packageName, boolean suspended) {
        try {
            Context ctx = getSystemContext();
            if (ctx == null) return false;
            PackageManager pm = ctx.getPackageManager();
            if (pm == null) return false;
            Method method = findCompatibleSetPackagesSuspendedMethod(pm.getClass());
            if (method == null) return false;
            Object[] args = buildPackageSuspendedArgs(method.getParameterTypes(), packageName, suspended);
            long token = Binder.clearCallingIdentity();
            Object result;
            try {
                result = method.invoke(pm, args);
            } finally {
                Binder.restoreCallingIdentity(token);
            }
            if (result instanceof String[]) return ((String[]) result).length == 0;
            return true;
        } catch (Throwable t) {
            logDebug("setPackagesSuspended failed: " + t.getClass().getSimpleName());
            return false;
        }
    }

    private Method findCompatibleSetPackagesSuspendedMethod(Class<?> clazz) {
        if (clazz == null) return null;
        String cacheKey = clazz.getName() + "#compatibleSetPackagesSuspended";
        Object cached = methodLookupCache.get(cacheKey);
        if (cached instanceof Method) return (Method) cached;
        if (cached == REFLECTION_MISS) return null;
        Method method = findSetPackagesSuspendedIn(clazz.getMethods());
        if (method == null) method = findSetPackagesSuspendedIn(clazz.getDeclaredMethods());
        if (method != null) {
            try { method.setAccessible(true); } catch (Throwable ignored) {}
            methodLookupCache.put(cacheKey, method);
            return method;
        }
        methodLookupCache.put(cacheKey, REFLECTION_MISS);
        return null;
    }

    private Method findSetPackagesSuspendedIn(Method[] methods) {
        for (Method method : methods) {
            if (!"setPackagesSuspended".equals(method.getName())) continue;
            Class<?>[] params = method.getParameterTypes();
            boolean hasPackages = false;
            boolean hasSuspended = false;
            for (Class<?> param : params) {
                if (param.isArray() && param.getComponentType() == String.class) hasPackages = true;
                if (param == boolean.class) hasSuspended = true;
            }
            if (hasPackages && hasSuspended) return method;
        }
        return null;
    }

    private Object[] buildPackageSuspendedArgs(Class<?>[] params, String packageName, boolean suspended) {
        Object[] args = new Object[params.length];
        String message = suspended ? "Monika 监督模式短时冻结" : null;
        for (int i = 0; i < params.length; i++) {
            Class<?> type = params[i];
            if (type.isArray() && type.getComponentType() == String.class) {
                args[i] = new String[]{packageName};
            } else if (type == boolean.class) {
                args[i] = suspended;
            } else if (type == int.class) {
                args[i] = 0;
            } else if (type == String.class) {
                args[i] = message;
            } else {
                args[i] = null;
            }
        }
        return args;
    }

    private boolean forceStopPackage(String packageName) {
        if (!isSystemServerProcess()) return false;
        try {
            Context ctx = getSystemContext();
            if (ctx != null) {
                Object activityManager = ctx.getSystemService(Context.ACTIVITY_SERVICE);
                if (activityManager != null) {
                    Method method = findMethod(activityManager.getClass(), "forceStopPackage", String.class);
                    if (method != null) {
                        method.invoke(activityManager, packageName);
                        return true;
                    }
                }
            }
        } catch (Throwable t) {
            logDebug("ActivityManager forceStopPackage failed: " + t.getClass().getSimpleName());
        }
        try {
            Class<?> am = cachedClassForName("android.app.ActivityManager");
            Method getService = am != null ? findMethod(am, "getService") : null;
            Object service = getService != null ? getService.invoke(null) : null;
            if (service == null) return false;
            Method method = findMethod(service.getClass(), "forceStopPackage", String.class, int.class);
            if (method == null) method = findMethod(service.getClass(), "forceStopPackageAsUser", String.class, int.class);
            if (method == null) return false;
            method.invoke(service, packageName, 0);
            return true;
        } catch (Throwable t) {
            log(Log.WARN, TAG, "IActivityManager forceStopPackage failed: " + t.getClass().getSimpleName());
            return false;
        }
    }

    private JSONArray frozenPackagesJson(long now) {
        cleanupFrozenPackages(now);
        JSONArray arr = new JSONArray();
        try {
            for (FrozenPackageRecord record : frozenPackages.values()) {
                if (record.until <= now) continue;
                arr.put(new JSONObject()
                        .put("package_name", record.packageName)
                        .put("app_name", record.appName)
                        .put("frozen_at", isoTime(record.frozenAt))
                        .put("until", isoTime(record.until))
                        .put("mode", record.mode)
                        .put("reason", record.reason));
                if (arr.length() >= 8) break;
            }
        } catch (Throwable ignored) {}
        return arr;
    }

    private void cleanupFrozenPackages(long now) {
        try {
            for (String pkg : frozenPackages.keySet()) {
                FrozenPackageRecord record = frozenPackages.get(pkg);
                if (record == null || record.until <= now) {
                    if (record != null && "suspended".equals(record.mode)) {
                        setPackageSuspended(record.packageName, false);
                    }
                    frozenPackages.remove(pkg);
                }
            }
        } catch (Throwable ignored) {}
    }

    private java.util.List<java.util.regex.Pattern> compileSafePatterns(JSONArray arr) {
        java.util.ArrayList<java.util.regex.Pattern> out = new java.util.ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            String pattern = safeString(arr.optString(i));
            if (!isSafeSupervisionPattern(pattern)) continue;
            try {
                out.add(java.util.regex.Pattern.compile(pattern, java.util.regex.Pattern.CASE_INSENSITIVE));
            } catch (Throwable ignored) {}
            if (out.size() >= 12) break;
        }
        return out;
    }

    private boolean isSafeSupervisionPattern(String pattern) {
        if (pattern == null || pattern.length() == 0 || pattern.length() > 120) return false;
        String compact = pattern.replaceAll("\\s+", "");
        if (".*".equals(compact) || ".+".equals(compact) || "[\\s\\S]*".equals(compact) || "[\\S\\s]*".equals(compact)) return false;
        if (pattern.matches(".*\\\\[1-9].*")) return false;
        if (pattern.contains("(?<=") || pattern.contains("(?<!")) return false;
        if (pattern.matches(".*\\([^)]*[+*][^)]*\\)[+*{].*")) return false;
        if (pattern.matches(".*(?:\\.\\*){3,}.*")) return false;
        if (pattern.matches(".*\\{\\d{3,}(?:,|\\}).*")) return false;
        return true;
    }

    private long parseIsoMillis(String value, long fallback) {
        try {
            if (value == null || value.length() == 0) return fallback;
            return java.time.Instant.parse(value).toEpochMilli();
        } catch (Throwable ignored) {
            return fallback;
        }
    }

    private boolean strictBoolean(JSONObject object, String key, boolean defaultWhenMissing) {
        if (object == null || !object.has(key) || object.isNull(key)) return defaultWhenMissing;
        Object value = object.opt(key);
        return value instanceof Boolean && ((Boolean) value).booleanValue();
    }

    private boolean isProtectedFreezePackage(String packageName) {
        if (isIgnoredPackage(packageName)) return true;
        if (TARGET_PACKAGE.equals(packageName)) return true;
        if (packageName.startsWith("com.monika.dashboard")) return true;
        if (isSystemApplicationPackage(packageName)) return true;
        if (packageName.startsWith("com.android.inputmethod")) return true;
        if (packageName.startsWith("com.google.android.inputmethod")) return true;
        switch (packageName) {
            case "com.android.settings":
            case "com.miui.securitycenter":
            case "com.miui.securityadd":
            case "com.miui.powerkeeper":
            case "com.xiaomi.xmsf":
            case "com.google.android.gms":
            case "com.android.permissioncontroller":
            case "com.google.android.permissioncontroller":
            case "com.android.packageinstaller":
            case "com.google.android.packageinstaller":
            case "com.android.providers.downloads":
            case "com.android.providers.media":
            case "com.android.phone":
            case "com.google.android.dialer":
            case "com.android.contacts":
            case "com.android.server.telecom":
            case "com.android.bluetooth":
            case "com.android.nfc":
                return true;
            default:
                return false;
        }
    }

    private boolean isSystemApplicationPackage(String packageName) {
        try {
            if (packageName == null || packageName.length() == 0) return false;
            if (packageName.startsWith("com.android.")) return true;
            Context ctx = getSystemContext();
            if (ctx == null) return false;
            PackageManager pm = ctx.getPackageManager();
            if (pm == null) return false;
            ApplicationInfo info = pm.getApplicationInfo(packageName, 0);
            int systemFlags = ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP;
            return (info.flags & systemFlags) != 0;
        } catch (Throwable t) {
            logDebug("system app freeze guard failed: " + t.getClass().getSimpleName());
            return packageName != null && packageName.startsWith("com.android.");
        }
    }

    private void postSupervisionFreezeNotification(String packageName, String appName, String reason, long until) {
        try {
            Context ctx = getSystemContext();
            if (ctx == null) return;
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel channel = new NotificationChannel(
                        SUPERVISION_CHANNEL_ID,
                        "Monika 监督冻结",
                        NotificationManager.IMPORTANCE_HIGH);
                channel.setDescription("监督模式冻结应用时提醒");
                nm.createNotificationChannel(channel);
            }
            String label = safeString(appName).length() > 0 ? safeString(appName) : safeString(packageName);
            String body = safeString(reason);
            if (body.length() == 0) body = "监督模式已冻结该应用";
            body = body + "。自动统一解冻时间：" + localClock(until);
            Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(ctx, SUPERVISION_CHANNEL_ID)
                    : new Notification.Builder(ctx);
            builder.setSmallIcon(android.R.drawable.stat_sys_warning)
                    .setContentTitle("已冻结 " + label)
                    .setContentText(body.length() > 120 ? body.substring(0, 120) : body)
                    .setStyle(new Notification.BigTextStyle().bigText(body.length() > 500 ? body.substring(0, 500) : body))
                    .setAutoCancel(true)
                    .setShowWhen(true)
                    .setWhen(System.currentTimeMillis())
                    .setCategory(Notification.CATEGORY_STATUS)
                    .setPriority(Notification.PRIORITY_HIGH)
                    .setDefaults(Notification.DEFAULT_VIBRATE)
                    .setVisibility(Notification.VISIBILITY_PUBLIC);
            nm.notify(SUPERVISION_FREEZE_NOTIFICATION_ID, builder.build());
        } catch (Throwable t) {
            logDebug("supervision freeze notification skipped: " + t.getClass().getSimpleName());
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
                    .setPriority(Notification.PRIORITY_HIGH)
                    .setDefaults(Notification.DEFAULT_VIBRATE | Notification.DEFAULT_SOUND)
                    .setVisibility(Notification.VISIBILITY_PUBLIC);
            nm.notify(MESSAGE_NOTIFICATION_ID, builder.build());
        } catch (Throwable t) {
            logDebug("LSP message notification skipped: " + t.getClass().getSimpleName());
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
        boolean includeMedia = directUploadMedia && mediaPlaying;
        // Screen off — show sleeping or media info
        if ("sleeping".equals(foregroundPackage)) {
            if (includeMedia && mediaApp.length() > 0) {
                return mediaTitle.length() > 0 ? mediaApp + "正在播放" + mediaTitle : mediaApp + "正在播放";
            }
            return "(-.-)zzZ";
        }
        boolean foregroundValid = foregroundApp.length() > 0
                && !"idle".equals(foregroundPackage)
                && !"idle".equals(foregroundApp);
        if (foregroundValid && includeMedia && mediaTitle.length() > 0 && mediaApp.length() > 0 && !mediaApp.equals(foregroundApp)) {
            return "正在用" + foregroundApp + "，后台" + mediaApp + "正在播放" + mediaTitle;
        }
        if (foregroundValid && includeMedia && mediaTitle.length() > 0) {
            return "正在用" + foregroundApp + "播放" + mediaTitle;
        }
        if (!foregroundValid && includeMedia && mediaTitle.length() > 0 && mediaApp.length() > 0) {
            return mediaApp + "正在播放" + mediaTitle;
        }
        if (!foregroundValid && includeMedia && mediaApp.length() > 0) {
            return mediaApp + "正在播放";
        }
        if (!foregroundValid && includeMedia && mediaTitle.length() > 0) {
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

    private String localClock(long millis) {
        try {
            return new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new java.util.Date(millis));
        } catch (Throwable ignored) {
            return isoTime(millis);
        }
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

    private String normalizeNonce(String value) {
        String normalized = safeString(value);
        return normalized.length() >= 24 ? normalized : "";
    }

    private String getBrowserTitleNonce(boolean forceReload) {
        String current = browserTitleNonce;
        if (current.length() > 0) return current;
        long now = System.currentTimeMillis();
        if (!forceReload && now - lastBrowserNonceLoadAt < BROWSER_NONCE_RELOAD_MS) return "";
        lastBrowserNonceLoadAt = now;
        try { loadDirectUploadConfig(); } catch (Throwable ignored) {}
        return browserTitleNonce;
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

    private String cleanBrowserTitle(String packageName, String title) {
        String cleaned = cleanTitle(title);
        if (cleaned == null) return null;
        cleaned = stripBrowserTitleDecoration(packageName, cleaned);
        if (cleaned == null) return null;
        if (isUrlLikeBrowserTitle(cleaned)) return null;
        return isGenericBrowserTitle(packageName, cleaned) ? null : cleaned;
    }

    private void applyForegroundTitle(String title, String source) {
        foregroundTitle = safeString(title);
        foregroundTitleSource = safeString(source);
        foregroundTitleUpdatedAt = System.currentTimeMillis();
    }

    private boolean shouldApplyBrowserTitleCandidate(String packageName, String title, String source) {
        if (!isBrowserPackage(packageName)) return true;
        String incomingTitle = safeString(title);
        if (incomingTitle.length() == 0) return true;
        String currentTitle = foregroundTitle;
        if (currentTitle.length() == 0) return true;
        if (!packageName.equals(foregroundPackage)) return true;

        int currentRank = browserTitleSourceRank(foregroundTitleSource);
        int incomingRank = browserTitleSourceRank(source);
        boolean currentFresh = System.currentTimeMillis() - foregroundTitleUpdatedAt < BROWSER_WEB_TITLE_FRESH_MS;
        if (!currentFresh || incomingRank >= currentRank) return true;

        String currentNormalized = normalizeBrowserTitleForCompare(currentTitle);
        String incomingNormalized = normalizeBrowserTitleForCompare(incomingTitle);
        if (incomingNormalized.equals(currentNormalized)) return false;
        if (incomingNormalized.contains(currentNormalized)) return false;
        return !isVolatileBrowserTitleSource(source);
    }

    private int browserTitleSourceRank(String source) {
        String normalized = safeString(source).toLowerCase(Locale.US);
        if (isWebTitleSource(normalized)) return 3;
        if (normalized.startsWith("task")) return 2;
        if (normalized.startsWith("activity")
                || normalized.startsWith("window")
                || normalized.startsWith("focus")) {
            return 1;
        }
        return 0;
    }

    private boolean isVolatileBrowserTitleSource(String source) {
        String normalized = safeString(source).toLowerCase(Locale.US);
        return normalized.startsWith("window")
                || normalized.startsWith("focus");
    }

    private boolean isWebTitleSource(String source) {
        String normalized = safeString(source).toLowerCase(Locale.US);
        return normalized.startsWith("web") || normalized.startsWith("aosp");
    }

    private boolean isGenericBrowserTitle(String packageName, String title) {
        String normalized = normalizeBrowserTitleForCompare(title);
        if (normalized.length() == 0) return false;
        String appLabel = normalizeBrowserTitleForCompare(resolveAppLabel(packageName));
        if (appLabel.length() > 0 && normalized.equals(appLabel)) return true;
        switch (normalized) {
            case "browser":
            case "web browser":
            case "internet":
            case "webview":
            case "chrome":
            case "google chrome":
            case "firefox":
            case "mozilla firefox":
            case "edge":
            case "microsoft edge":
            case "brave":
            case "opera":
            case "vivaldi":
            case "duckduckgo":
            case "samsung internet":
            case "mi browser":
            case "uc browser":
            case "new tab":
            case "about:blank":
            case "about:home":
            case "浏览器":
            case "系统浏览器":
            case "小米浏览器":
            case "网页":
            case "新标签页":
            case "空白页":
                return true;
            default:
                return false;
        }
    }

    private String stripBrowserTitleDecoration(String packageName, String title) {
        String cleaned = cleanTitle(title);
        if (cleaned == null) return null;

        String strippedPrefix = stripUrlPrefixFromTitle(cleaned);
        if (strippedPrefix != null) cleaned = strippedPrefix;

        for (int i = 0; i < 2; i++) {
            String withoutSuffix = stripBrowserSuffix(packageName, cleaned);
            if (withoutSuffix == null || withoutSuffix.equals(cleaned)) break;
            cleaned = withoutSuffix;
        }
        return cleanTitle(cleaned);
    }

    private String stripUrlPrefixFromTitle(String title) {
        String cleaned = cleanTitle(title);
        if (cleaned == null) return null;
        String[] separators = new String[] {": ", " - ", " – ", " — ", " | "};
        for (String separator : separators) {
            int index = cleaned.indexOf(separator);
            if (index <= 0 || index + separator.length() >= cleaned.length()) continue;
            String head = cleaned.substring(0, index).trim();
            String tail = cleaned.substring(index + separator.length()).trim();
            if (tail.length() == 0) continue;
            if (isUrlLikeBrowserTitle(head)) return tail;
        }
        return cleaned;
    }

    private String stripBrowserSuffix(String packageName, String title) {
        String cleaned = cleanTitle(title);
        if (cleaned == null) return null;
        String[] separators = new String[] {" - ", " – ", " — ", " | ", " · "};
        for (String separator : separators) {
            int index = cleaned.lastIndexOf(separator);
            if (index <= 0 || index + separator.length() >= cleaned.length()) continue;
            String head = cleaned.substring(0, index).trim();
            String tail = cleaned.substring(index + separator.length()).trim();
            if (head.length() == 0 || tail.length() == 0) continue;
            if (isKnownBrowserLabel(packageName, tail)) return head;
        }
        return cleaned;
    }

    private boolean isKnownBrowserLabel(String packageName, String value) {
        String normalized = normalizeBrowserTitleForCompare(value);
        if (normalized.length() == 0) return false;
        String appLabel = normalizeBrowserTitleForCompare(resolveAppLabel(packageName));
        if (appLabel.length() > 0 && normalized.equals(appLabel)) return true;
        switch (normalized) {
            case "browser":
            case "web browser":
            case "internet":
            case "chrome":
            case "google chrome":
            case "firefox":
            case "mozilla firefox":
            case "edge":
            case "microsoft edge":
            case "brave":
            case "opera":
            case "vivaldi":
            case "duckduckgo":
            case "samsung internet":
            case "mi browser":
            case "uc browser":
            case "浏览器":
            case "系统浏览器":
            case "小米浏览器":
                return true;
            default:
                return false;
        }
    }

    private boolean isUrlLikeBrowserTitle(String title) {
        String cleaned = cleanTitle(title);
        if (cleaned == null) return false;
        String lower = cleaned.toLowerCase(Locale.US);
        if (lower.startsWith("http://")
                || lower.startsWith("https://")
                || lower.startsWith("file://")
                || lower.startsWith("content://")
                || lower.startsWith("about:")
                || lower.startsWith("chrome://")) {
            return true;
        }
        return lower.matches("^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}(:\\d+)?(/.*)?$");
    }

    private String normalizeBrowserTitleForCompare(String title) {
        String cleaned = cleanTitle(title);
        if (cleaned == null) return "";
        return cleaned.toLowerCase(Locale.US)
                .replaceAll("\\s+", " ")
                .replaceAll("[\\p{Punct}。！？、，；：~～]+$", "")
                .trim();
    }

    private String cleanTitle(String title) {
        if (title == null) return null;
        String cleaned = title
                .replace('\n', ' ')
                .replace('\r', ' ')
                .replaceAll("[\\u200B-\\u200D\\uFEFF]", "")
                .trim();
        if (cleaned.length() == 0 || "null".equals(cleaned)) return null;
        if (cleaned.length() > 256) return cleaned.substring(0, 256);
        return cleaned;
    }

    // ──────────────────────────────────────────────
    //  Minimal WebSocket client for LSPosed data upload
    //  Uses javax.net.ssl.SSLSocket — no external dependencies
    // ──────────────────────────────────────────────
    private static final class SupervisionFreezeAlert {
        final String id;
        final java.util.List<java.util.regex.Pattern> violationPatterns;
        final java.util.List<java.util.regex.Pattern> recoveryPatterns;
        final long activeUntil;
        final long freezeUntil;
        final String reason;

        SupervisionFreezeAlert(
                String id,
                java.util.List<java.util.regex.Pattern> violationPatterns,
                java.util.List<java.util.regex.Pattern> recoveryPatterns,
                long activeUntil,
                long freezeUntil,
                String reason) {
            this.id = id;
            this.violationPatterns = violationPatterns;
            this.recoveryPatterns = recoveryPatterns;
            this.activeUntil = activeUntil;
            this.freezeUntil = freezeUntil;
            this.reason = reason;
        }
    }

    private static final class FrozenPackageRecord {
        final String packageName;
        final String appName;
        final long frozenAt;
        final long until;
        final String reason;
        final String mode;

        FrozenPackageRecord(String packageName, String appName, long frozenAt, long until, String reason, String mode) {
            this.packageName = packageName;
            this.appName = appName;
            this.frozenAt = frozenAt;
            this.until = until;
            this.reason = reason;
            this.mode = mode;
        }
    }

    private class LspWebSocketClient {
        private static final int OP_TEXT  = 0x1;
        private static final int OP_CLOSE = 0x8;
        private static final int OP_PING  = 0x9;
        private static final int OP_PONG  = 0xA;
        private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
        private static final int RECEIVE_BUF = 8192;
        private static final int MAX_WS_FRAME_BYTES = 256 * 1024;
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
            boolean success = false;
            try {
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
                String statusLine = respStr.split("\r\n", 2)[0];
                if (!statusLine.matches("^HTTP/1\\.1 101\\b.*")) {
                    throw new IOException("handshake failed: " + statusLine);
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
                success = true;
            } finally {
                if (!success) {
                    connected = false;
                    running = false;
                    closeQuietly();
                    clearModuleClientIfCurrent();
                }
            }
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
                if (!manualDisconnect) {
                    recordWsDisconnectedForBackoff();
                    scheduleWsReconnect();
                }
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
            if (len > MAX_WS_FRAME_BYTES) {
                throw new IOException("frame too large");
            }
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
                long value = len & 0xFFFFFFFFL;
                for (int i = 7; i >= 0; i--) {
                    out.write((int) ((value >> (i * 8)) & 0xFF));
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
                            if (!manualDisconnect) {
                                recordWsDisconnectedForBackoff();
                                scheduleWsReconnect();
                            }
                            return;
                        default:
                            // Ignore other frame types (ack, messages, etc.)
                            break;
                    }
                }
            } catch (Throwable t) {
                // Connection lost — trigger immediate reconnect
                logDebug("WS reader error: " + t.getClass().getSimpleName());
                connected = false;
                if (!manualDisconnect) {
                    recordWsDisconnectedForBackoff();
                    scheduleWsReconnect();
                }
            } finally {
                connected = false;
                running = false;
                closeQuietly();
                clearModuleClientIfCurrent();
                if (unexpectedDisconnect && !manualDisconnect) {
                    recordWsDisconnectedForBackoff();
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
                    logDebug("WS ping failed: " + t.getClass().getSimpleName());
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
                recordWsDisconnectedForBackoff();
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
                int b2 = in.read();
                int b3 = in.read();
                if (b2 < 0 || b3 < 0) return null;
                len = ((b2 & 0xFF) << 8) | (b3 & 0xFF);
            } else if (len == 127) {
                long longLen = 0;
                for (int i = 0; i < 8; i++) {
                    int next = in.read();
                    if (next < 0) return null;
                    longLen = (longLen << 8) | (next & 0xFFL);
                }
                if (longLen > Integer.MAX_VALUE) throw new IOException("frame too large");
                len = (int) longLen;
            }
            if (len > MAX_WS_FRAME_BYTES) throw new IOException("frame too large");

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
                    if (read == 0) continue;
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
