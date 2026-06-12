package com.monika.dashboard.lsposed;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;

import org.json.JSONObject;

import java.util.List;

final class LspDirectFeature {
    interface Host {
        Context systemContext();
        Handler uploadHandler();
        SharedPreferences remotePreferences(String name) throws Throwable;
        boolean systemServerProcess();
        long heartbeatMs();
        String isoTime(long millis);
        void logInfo(String message);
        void logWarn(String message);
        void logDebug(String message);
    }

    private final LspDirectConfig config = new LspDirectConfig();
    private final LspForegroundFeature foregroundFeature;
    private final LspDeviceControlFeature deviceControlFeature;
    private final Host host;

    private final LspDirectReportBuilder reportBuilder;
    private final LspDirectTransport transport;
    private final LspDeviceCommandController deviceCommandController;
    private final LspDirectUploader uploader;
    private final LspViewerMessageBridge viewerMessageBridge;
    private final LspDirectConfigReceiver configReceiver;

    LspDirectFeature(
            String targetPackage,
            String targetReceiver,
            String configPermission,
            LspMediaTracker mediaTracker,
            LspForegroundFeature foregroundFeature,
            LspDeviceEnvironment deviceEnvironment,
            LspDeviceControlFeature deviceControlFeature,
            LspNotificationCenter notificationCenter,
            Host host) {
        this.foregroundFeature = foregroundFeature;
        this.deviceControlFeature = deviceControlFeature;
        this.host = host;
        reportBuilder = new LspDirectReportBuilder(
                mediaTracker,
                foregroundFeature.reader(),
                deviceEnvironment,
                deviceControlFeature,
                newDirectReportBuilderHost());
        transport = new LspDirectTransport(newDirectTransportHost());
        deviceCommandController = new LspDeviceCommandController(newDeviceCommandHost());
        uploader = new LspDirectUploader(
                config,
                reportBuilder,
                transport,
                deviceCommandController,
                newDirectUploaderHost());
        viewerMessageBridge = new LspViewerMessageBridge(
                targetPackage,
                targetReceiver,
                configPermission,
                deviceCommandController,
                notificationCenter,
                newViewerMessageBridgeHost());
        configReceiver = new LspDirectConfigReceiver(
                config,
                targetPackage,
                configPermission,
                newDirectConfigReceiverHost());
    }

    boolean enabled() {
        return config.enabled();
    }

    boolean uploadForeground() {
        return config.uploadForeground();
    }

    boolean uploadMedia() {
        return config.uploadMedia();
    }

    void requestUpload(boolean force) {
        uploader.request(force);
    }

    void loadConfig() {
        configReceiver.load();
    }

    void registerConfigReceiver(Handler handler) {
        configReceiver.register(handler);
    }

    String browserTitleNonce(boolean forceReload) {
        return config.browserTitleNonce(
                host.systemContext(),
                () -> host.remotePreferences(LspDirectConfig.PREFS_NAME),
                forceReload);
    }

    private LspDirectReportBuilder.Host newDirectReportBuilderHost() {
        return new LspDirectReportBuilder.Host() {
            @Override
            public long heartbeatMs() {
                return host.heartbeatMs();
            }

            @Override
            public long minDirectUploadMs() {
                return LspDirectConfig.MIN_INTERVAL_MS;
            }

            @Override
            public long directIntervalMs() {
                return config.intervalMs();
            }

            @Override
            public boolean uploadForeground() {
                return config.uploadForeground();
            }

            @Override
            public boolean uploadMedia() {
                return config.uploadMedia();
            }

            @Override
            public boolean uploadNetwork() {
                return config.uploadNetwork();
            }

            @Override
            public boolean uploadVpn() {
                return config.uploadVpn();
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
            public String foregroundActivity() {
                return foregroundFeature.activityName();
            }

            @Override
            public String foregroundTitle() {
                return foregroundFeature.title();
            }

            @Override
            public String primaryDisplayTitle() {
                return foregroundFeature.primaryDisplayTitle(config.uploadMedia());
            }

            @Override
            public boolean supervisionCheckRequested() {
                return deviceControlFeature.shouldRequestReviewForReport();
            }

            @Override
            public String isoTime(long millis) {
                return host.isoTime(millis);
            }

            @Override
            public void logWarn(String message) {
                host.logWarn(message);
            }
        };
    }

    private LspDirectTransport.Host newDirectTransportHost() {
        return new LspDirectTransport.Host() {
            @Override
            public boolean enabled() {
                return config.enabled();
            }

            @Override
            public boolean systemServerProcess() {
                return host.systemServerProcess();
            }

            @Override
            public Handler uploadHandler() {
                return host.uploadHandler();
            }

            @Override
            public void requestDirectUpload(boolean force) {
                requestUpload(force);
            }

            @Override
            public void onReportDelivered(String body) {
                deviceControlFeature.markReviewSentIfRequested(body);
            }

            @Override
            public void onWsTextMessage(String text) {
                viewerMessageBridge.handleWsTextMessage(text);
            }

            @Override
            public void onPolledDeviceCommand(JSONObject command) {
                deviceCommandController.handleCommand(command, "message_poll");
            }

            @Override
            public void onPolledViewerMessage(String text) {
                viewerMessageBridge.forwardToApp(text);
            }

            @Override
            public void logInfo(String message) {
                host.logInfo(message);
            }

            @Override
            public void logWarn(String message) {
                host.logWarn(message);
            }

            @Override
            public void logDebug(String message) {
                host.logDebug(message);
            }
        };
    }

    private LspDirectUploader.Host newDirectUploaderHost() {
        return new LspDirectUploader.Host() {
            @Override
            public boolean systemServerProcess() {
                return host.systemServerProcess();
            }

            @Override
            public Handler uploadHandler() {
                return host.uploadHandler();
            }

            @Override
            public Context systemContext() {
                return host.systemContext();
            }

            @Override
            public void logWarn(String message) {
                host.logWarn(message);
            }

            @Override
            public void logDebug(String message) {
                host.logDebug(message);
            }
        };
    }

    private LspViewerMessageBridge.Host newViewerMessageBridgeHost() {
        return new LspViewerMessageBridge.Host() {
            @Override
            public Context systemContext() {
                return host.systemContext();
            }

            @Override
            public void logDebug(String message) {
                host.logDebug(message);
            }
        };
    }

    private LspDirectConfigReceiver.Host newDirectConfigReceiverHost() {
        return new LspDirectConfigReceiver.Host() {
            @Override
            public Context systemContext() {
                return host.systemContext();
            }

            @Override
            public SharedPreferences remotePreferences() throws Throwable {
                return host.remotePreferences(LspDirectConfig.PREFS_NAME);
            }

            @Override
            public void disconnectTransport() {
                transport.disconnect();
            }

            @Override
            public void clearSupervisionFreeze(String reason) {
                deviceControlFeature.clearSupervisionFreeze(reason);
            }

            @Override
            public void requestDirectUpload(boolean force) {
                requestUpload(force);
            }

            @Override
            public void logInfo(String message) {
                host.logInfo(message);
            }

            @Override
            public void logWarn(String message) {
                host.logWarn(message);
            }

            @Override
            public void logDebug(String message) {
                host.logDebug(message);
            }
        };
    }

    private LspDeviceCommandHost newDeviceCommandHost() {
        return new LspDeviceCommandHost() {
            @Override
            public Handler uploadHandler() {
                return host.uploadHandler();
            }

            @Override
            public String directServerUrl() {
                return config.serverUrl();
            }

            @Override
            public String directToken() {
                return config.token();
            }

            @Override
            public void ensureWsConnected(String serverUrl, String token) {
                transport.ensureWsConnected(serverUrl, token);
            }

            @Override
            public boolean sendWsText(String text) {
                return transport.sendWsText(text);
            }

            @Override
            public boolean postAckHttp(String serverUrl, String token, String body) {
                return transport.postDeviceCommandEvent(serverUrl, token, body);
            }

            @Override
            public void logDebug(String message) {
                host.logDebug(message);
            }

            @Override
            public String isoTime(long millis) {
                return host.isoTime(millis);
            }

            @Override
            public long nextDailyUnfreezeAt(long now) {
                return deviceControlFeature.nextDailyUnfreezeAt(now);
            }

            @Override
            public JSONObject frozenState(long now) {
                return deviceControlFeature.frozenState(now);
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
            public String foregroundTitle() {
                return foregroundFeature.title();
            }

            @Override
            public boolean isInstalledPackage(String packageName) {
                return deviceControlFeature.isInstalledPackage(packageName);
            }

            @Override
            public List<LspInstalledApp> installedApps() {
                return deviceControlFeature.installedApps();
            }

            @Override
            public List<LspFrozenPackage> frozenPackages() {
                return deviceControlFeature.frozenPackages(System.currentTimeMillis());
            }

            @Override
            public boolean unfreezePackage(String packageName) {
                return deviceControlFeature.unfreezePackage(packageName);
            }

            @Override
            public LspFreezeResult freezePackage(String packageName, String reason, long now, long until) {
                return deviceControlFeature.freezePackage(packageName, reason, now, until);
            }

            @Override
            public boolean postSayNotification(String commandId, String text) {
                return deviceControlFeature.postDeviceCommandSay(commandId, text);
            }

            @Override
            public boolean vibrate(long durationMs) {
                return deviceControlFeature.vibrate(durationMs);
            }

            @Override
            public void requestDirectUpload() {
                requestUpload(true);
            }

            @Override
            public boolean applySupervisionPolicy(JSONObject payload) {
                return deviceControlFeature.applySupervisionPolicy(payload);
            }

            @Override
            public void finishPendingSupervisionReview() {
                deviceControlFeature.finishPendingSupervisionReview();
            }
        };
    }
}
