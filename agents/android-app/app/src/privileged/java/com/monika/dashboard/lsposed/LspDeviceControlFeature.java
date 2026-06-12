package com.monika.dashboard.lsposed;

import android.content.Context;
import android.os.Handler;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

final class LspDeviceControlFeature {
    interface Host {
        Context systemContext();
        Handler uploadHandler();
        boolean directEnabled();
        boolean uploadForeground();
        boolean uploadMedia();
        boolean systemServerProcess();
        boolean networkConnected();
        String foregroundPackage();
        String foregroundApp();
        String primaryDisplayTitle(boolean includeMedia);
        boolean ignoredPackage(String packageName);
        String resolveAppLabel(String packageName);
        String isoTime(long millis);
        String localClock(long millis);
        void requestDirectUpload(boolean force);
        void logDebug(String message);
        void logWarn(String message);
    }

    private final LspDeviceFeedback feedback;
    private final LspPackageController packageController;
    private final LspSupervisionCoordinator supervisionCoordinator;

    LspDeviceControlFeature(
            LspHookSupport hookSupport,
            LspNotificationCenter notificationCenter,
            String targetPackage,
            Host host) {
        feedback = new LspDeviceFeedback(notificationCenter, newFeedbackHost(host));
        packageController = new LspPackageController(hookSupport, newPackageControllerHost(host), targetPackage);
        supervisionCoordinator = new LspSupervisionCoordinator(newSupervisionCoordinatorHost(host));
    }

    boolean isProtectedPackage(String packageName) {
        return packageController.isProtectedPackage(packageName);
    }

    JSONObject frozenState(long now) {
        return packageController.frozenState(now);
    }

    List<LspFrozenPackage> frozenPackages(long now) {
        return packageController.frozenPackages(now);
    }

    JSONArray frozenPackagesJson(long now) {
        return packageController.frozenPackagesJson(now);
    }

    boolean unfreezePackage(String packageName) {
        return packageController.unfreezePackage(packageName);
    }

    LspFreezeResult freezePackage(String packageName, String reason, long now, long until) {
        return packageController.freezePackage(packageName, reason, now, until);
    }

    boolean isInstalledPackage(String packageName) {
        return packageController.isInstalledPackage(packageName);
    }

    List<LspInstalledApp> installedApps() {
        return packageController.installedApps();
    }

    boolean postDeviceCommandSay(String commandId, String text) {
        return feedback.postDeviceCommandSay(commandId, text);
    }

    boolean vibrate(long durationMs) {
        return feedback.vibrate(durationMs);
    }

    void evaluateSupervision(long now) {
        supervisionCoordinator.evaluate(now);
    }

    void scheduleDailyCleanup(Handler handler) {
        supervisionCoordinator.scheduleDailyCleanup(handler);
    }

    void clearSupervisionFreeze(String reason) {
        supervisionCoordinator.clearFreeze(reason);
    }

    long nextDailyUnfreezeAt(long now) {
        return supervisionCoordinator.nextDailyUnfreezeAt(now);
    }

    boolean shouldRequestReviewForReport() {
        return supervisionCoordinator.shouldRequestReviewForReport();
    }

    void markReviewSentIfRequested(String body) {
        supervisionCoordinator.markReviewSentIfRequested(body);
    }

    boolean applySupervisionPolicy(JSONObject payload) {
        return supervisionCoordinator.applyPolicy(payload);
    }

    void finishPendingSupervisionReview() {
        supervisionCoordinator.finishPendingReview();
    }

    private LspDeviceFeedback.Host newFeedbackHost(Host host) {
        return new LspDeviceFeedback.Host() {
            @Override
            public Context systemContext() {
                return host.systemContext();
            }

            @Override
            public String localClock(long millis) {
                return host.localClock(millis);
            }

            @Override
            public void logDebug(String message) {
                host.logDebug(message);
            }
        };
    }

    private LspPackageController.Host newPackageControllerHost(Host host) {
        return new LspPackageController.Host() {
            @Override
            public Context systemContext() {
                return host.systemContext();
            }

            @Override
            public String resolveAppLabel(String packageName) {
                return host.resolveAppLabel(packageName);
            }

            @Override
            public boolean isIgnoredPackage(String packageName) {
                return host.ignoredPackage(packageName);
            }

            @Override
            public boolean isSystemServerProcess() {
                return host.systemServerProcess();
            }

            @Override
            public String isoTime(long millis) {
                return host.isoTime(millis);
            }

            @Override
            public void postFreezeNotification(String packageName, String appName, String reason, long until) {
                feedback.postSupervisionFreeze(packageName, appName, reason, until);
            }

            @Override
            public void cancelFreezeNotification(String packageName) {
                feedback.cancelSupervisionFreeze(packageName);
            }

            @Override
            public void logDebug(String message) {
                host.logDebug(message);
            }

            @Override
            public void logWarn(String message) {
                host.logWarn(message);
            }
        };
    }

    private LspSupervisionCoordinator.Host newSupervisionCoordinatorHost(Host host) {
        return new LspSupervisionCoordinator.Host() {
            @Override
            public Context systemContext() {
                return host.systemContext();
            }

            @Override
            public Handler uploadHandler() {
                return host.uploadHandler();
            }

            @Override
            public boolean enabled() {
                return host.directEnabled();
            }

            @Override
            public boolean uploadForeground() {
                return host.uploadForeground();
            }

            @Override
            public boolean systemServerProcess() {
                return host.systemServerProcess();
            }

            @Override
            public boolean networkConnected() {
                return host.networkConnected();
            }

            @Override
            public String foregroundPackage() {
                return host.foregroundPackage();
            }

            @Override
            public String foregroundApp() {
                return host.foregroundApp();
            }

            @Override
            public String primaryDisplayTitle() {
                return host.primaryDisplayTitle(host.uploadMedia());
            }

            @Override
            public boolean protectedPackage(String packageName) {
                return isProtectedPackage(packageName);
            }

            @Override
            public LspFreezeResult freezePackage(String packageName, String reason, long now, long until) {
                return LspDeviceControlFeature.this.freezePackage(packageName, reason, now, until);
            }

            @Override
            public boolean clearFreeze(String reason) {
                return packageController.clear(reason);
            }

            @Override
            public void requestDirectUpload(boolean force) {
                host.requestDirectUpload(force);
            }

            @Override
            public void logDebug(String message) {
                host.logDebug(message);
            }
        };
    }
}
