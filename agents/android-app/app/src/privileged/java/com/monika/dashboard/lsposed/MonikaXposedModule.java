package com.monika.dashboard.lsposed;

import android.content.Context;
import android.os.Handler;
import android.util.Log;

import androidx.annotation.NonNull;

import com.monika.dashboard.BuildConfig;

import io.github.libxposed.api.XposedModule;
import io.github.libxposed.api.XposedModuleInterface;

public final class MonikaXposedModule extends XposedModule {
    private static final String TAG = "MonikaLSP";
    private static final String TARGET_PACKAGE = BuildConfig.APPLICATION_ID;
    private static final String TARGET_RECEIVER = TARGET_PACKAGE + ".system.LsposedBridgeReceiver";
    private static final String CONFIG_PERMISSION = "com.monika.dashboard.permission.LSPOSED_CONFIG";
    private static final long HEARTBEAT_MS = 5 * 60_000L; // low-frequency fallback; events drive normal uploads
    
    // Static instance for global access
    private static MonikaXposedModule instance;
    
    private final LspHookSupport hookSupport = new LspHookSupport(this);
    private final LspRuntimeEnvironment runtime =
            new LspRuntimeEnvironment(hookSupport, newRuntimeEnvironmentHost());
    private final LspNotificationCenter notificationCenter = new LspNotificationCenter(TARGET_PACKAGE);
    private final LspMediaTracker mediaTracker =
            new LspMediaTracker(hookSupport, newMediaTrackerHost());
    private final LspForegroundFeature foregroundFeature =
            new LspForegroundFeature(
                    hookSupport,
                    TARGET_PACKAGE,
                    TARGET_RECEIVER,
                    CONFIG_PERMISSION,
                    newForegroundFeatureHost());
    private final LspDeviceEnvironment deviceEnvironment =
            new LspDeviceEnvironment(newDeviceEnvironmentHost());
    private final LspDeviceControlFeature deviceControlFeature =
            new LspDeviceControlFeature(
                    hookSupport,
                    notificationCenter,
                    TARGET_PACKAGE,
                    newDeviceControlFeatureHost());
    private final LspBrowserFeature browserFeature =
            new LspBrowserFeature(
                    hookSupport,
                    foregroundFeature.reader(),
                    foregroundFeature.titleState(),
                    newBrowserFeatureHost());
    private final LspDirectFeature directFeature =
            new LspDirectFeature(
                    TARGET_PACKAGE,
                    TARGET_RECEIVER,
                    CONFIG_PERMISSION,
                    mediaTracker,
                    foregroundFeature,
                    deviceEnvironment,
                    deviceControlFeature,
                    notificationCenter,
                    newDirectFeatureHost());
    private final LspSystemServerScope systemServerScope =
            new LspSystemServerScope(
                    runtime,
                    directFeature,
                    browserFeature,
                    foregroundFeature,
                    mediaTracker,
                    deviceControlFeature,
                    newSystemServerScopeHost());

    private LspRuntimeEnvironment.Host newRuntimeEnvironmentHost() {
        return new LspRuntimeEnvironment.Host() {
            @Override
            public void logInfo(String message) {
                log(Log.INFO, TAG, message);
            }

            @Override
            public void logWarn(String message) {
                log(Log.WARN, TAG, message);
            }

            @Override
            public void logDebug(String message) {
                MonikaXposedModule.this.logDebug(message);
            }
        };
    }

    private LspBrowserFeature.Host newBrowserFeatureHost() {
        return new LspBrowserFeature.Host() {
            @Override
            public Context systemContext() {
                return runtime.systemContext();
            }

            @Override
            public String browserTitleNonce(boolean forceReload) {
                return getBrowserTitleNonce(forceReload);
            }

            @Override
            public String resolveAppLabel(String packageName) {
                return runtime.resolveAppLabel(packageName);
            }

            @Override
            public String resolveAppLabel(Context context, String packageName) {
                return runtime.resolveAppLabel(context, packageName);
            }

            @Override
            public boolean ignoredPackage(String packageName) {
                return runtime.ignoredPackage(packageName);
            }

            @Override
            public String processName() {
                return runtime.processName();
            }

            @Override
            public String foregroundPackage() {
                return foregroundFeature.packageName();
            }

            @Override
            public void setBrowserForeground(String packageName, String appName, String activity) {
                foregroundFeature.setBrowserForeground(packageName, appName, activity);
            }

            @Override
            public void onBrowserTitleAccepted() {
                deviceControlFeature.evaluateSupervision(System.currentTimeMillis());
                maybeDirectUpload(true);
            }

            @Override
            public void logInfo(String message) {
                log(Log.INFO, TAG, message);
            }

            @Override
            public void logWarn(String message) {
                log(Log.WARN, TAG, message);
            }

            @Override
            public void logDebug(String message) {
                MonikaXposedModule.this.logDebug(message);
            }
        };
    }

    private LspMediaTracker.Host newMediaTrackerHost() {
        return new LspMediaTracker.Host() {
            @Override
            public Context systemContext() {
                return runtime.systemContext();
            }

            @Override
            public Handler uploadHandler() {
                return runtime.uploadHandler();
            }

            @Override
            public String resolveAppLabel(String packageName) {
                return runtime.resolveAppLabel(packageName);
            }

            @Override
            public void requestDirectUpload(boolean force) {
                maybeDirectUpload(force);
            }

            @Override
            public void logInfo(String message) {
                log(Log.INFO, TAG, message);
            }

            @Override
            public void logWarn(String message) {
                log(Log.WARN, TAG, message);
            }

            @Override
            public void logDebug(String message) {
                MonikaXposedModule.this.logDebug(message);
            }
        };
    }

    private LspForegroundFeature.Host newForegroundFeatureHost() {
        return new LspForegroundFeature.Host() {
            @Override
            public Context systemContext() {
                return runtime.systemContext();
            }

            @Override
            public boolean screenInteractive() {
                return runtime.screenInteractive();
            }

            @Override
            public boolean ignoredPackage(String packageName) {
                return runtime.ignoredPackage(packageName);
            }

            @Override
            public String resolveAppLabel(String packageName) {
                return runtime.resolveAppLabel(packageName);
            }

            @Override
            public LspMediaTracker.Snapshot mediaSnapshot() {
                return mediaTracker.snapshot();
            }

            @Override
            public void onSamplerStarted(Handler handler) {
                systemServerScope.onForegroundSamplerStarted(handler);
            }

            @Override
            public void onSnapshotComplete(boolean forceDirectUpload) {
                deviceControlFeature.evaluateSupervision(System.currentTimeMillis());
                maybeDirectUpload(forceDirectUpload);
            }

            @Override
            public void logInfo(String message) {
                log(Log.INFO, TAG, message);
            }

            @Override
            public void logWarn(String message) {
                log(Log.WARN, TAG, message);
            }

            @Override
            public void logDebug(String message) {
                MonikaXposedModule.this.logDebug(message);
            }
        };
    }

    private LspDeviceEnvironment.Host newDeviceEnvironmentHost() {
        return new LspDeviceEnvironment.Host() {
            @Override
            public Context systemContext() {
                return runtime.systemContext();
            }

            @Override
            public Handler uploadHandler() {
                return runtime.uploadHandler();
            }

            @Override
            public void logDebug(String message) {
                MonikaXposedModule.this.logDebug(message);
            }
        };
    }

    private LspDeviceControlFeature.Host newDeviceControlFeatureHost() {
        return new LspDeviceControlFeature.Host() {
            @Override
            public Context systemContext() {
                return runtime.systemContext();
            }

            @Override
            public Handler uploadHandler() {
                return runtime.uploadHandler();
            }

            @Override
            public boolean directEnabled() {
                return directFeature != null && directFeature.enabled();
            }

            @Override
            public boolean uploadForeground() {
                return directFeature != null && directFeature.uploadForeground();
            }

            @Override
            public boolean uploadMedia() {
                return directFeature != null && directFeature.uploadMedia();
            }

            @Override
            public boolean systemServerProcess() {
                return runtime.systemServerProcess();
            }

            @Override
            public boolean networkConnected() {
                return deviceEnvironment.isNetworkConnected();
            }

            @Override
            public String foregroundPackage() {
                return foregroundFeature.packageName();
            }

            @Override
            public String foregroundApp() {
                return foregroundFeature.appName();
            }

            @Override
            public String primaryDisplayTitle(boolean includeMedia) {
                return foregroundFeature.primaryDisplayTitle(includeMedia);
            }

            @Override
            public boolean ignoredPackage(String packageName) {
                return runtime.ignoredPackage(packageName);
            }

            @Override
            public String resolveAppLabel(String packageName) {
                return runtime.resolveAppLabel(packageName);
            }

            @Override
            public String isoTime(long millis) {
                return runtime.isoTime(millis);
            }

            @Override
            public String localClock(long millis) {
                return runtime.localClock(millis);
            }

            @Override
            public void requestDirectUpload(boolean force) {
                maybeDirectUpload(force);
            }

            @Override
            public void logDebug(String message) {
                MonikaXposedModule.this.logDebug(message);
            }

            @Override
            public void logWarn(String message) {
                log(Log.WARN, TAG, message);
            }
        };
    }

    private LspDirectFeature.Host newDirectFeatureHost() {
        return new LspDirectFeature.Host() {
            @Override
            public Context systemContext() {
                return runtime.systemContext();
            }

            @Override
            public Handler uploadHandler() {
                return runtime.uploadHandler();
            }

            @Override
            public android.content.SharedPreferences remotePreferences(String name) throws Throwable {
                return getRemotePreferences(name);
            }

            @Override
            public boolean systemServerProcess() {
                return runtime.systemServerProcess();
            }

            @Override
            public long heartbeatMs() {
                return HEARTBEAT_MS;
            }

            @Override
            public String isoTime(long millis) {
                return runtime.isoTime(millis);
            }

            @Override
            public void logInfo(String message) {
                log(Log.INFO, TAG, message);
            }

            @Override
            public void logWarn(String message) {
                log(Log.WARN, TAG, message);
            }

            @Override
            public void logDebug(String message) {
                MonikaXposedModule.this.logDebug(message);
            }
        };
    }

    private LspSystemServerScope.Host newSystemServerScopeHost() {
        return new LspSystemServerScope.Host() {
            @Override
            public void logWarn(String message) {
                log(Log.WARN, TAG, message);
            }

            @Override
            public void logDebug(String message) {
                MonikaXposedModule.this.logDebug(message);
            }
        };
    }

    @Override
    public void onModuleLoaded(@NonNull XposedModuleInterface.ModuleLoadedParam param) {
        instance = this;
        runtime.onModuleLoaded(param.getProcessName(), param.isSystemServer());
        log(Log.INFO, TAG, "onModuleLoaded: isSystemServer=" + param.isSystemServer()
                + " process=" + param.getProcessName()
                + " apiVersion=" + getApiVersion()
                + " framework=" + getFrameworkName() + " v" + getFrameworkVersion());
    }

    @Override
    public void onSystemServerStarting(@NonNull XposedModuleInterface.SystemServerStartingParam param) {
        systemServerScope.start(param.getClassLoader());
        // Keyboard input state is intentionally not collected: it is noisy and
        // tends to pollute timeline semantics without adding reliable context.
    }

    @Override
    public void onPackageReady(@NonNull XposedModuleInterface.PackageReadyParam param) {
        browserFeature.handlePackageReady(param.getPackageName(), param.getClassLoader());
    }

    private void logDebug(String message) {
        if (BuildConfig.DEBUG) {
            log(Log.DEBUG, TAG, message);
        }
    }

    private void maybeDirectUpload(boolean force) {
        directFeature.requestUpload(force);
    }

    private String getBrowserTitleNonce(boolean forceReload) {
        return directFeature.browserTitleNonce(forceReload);
    }

}
