package com.monika.dashboard.lsposed;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.Handler;

import androidx.core.content.ContextCompat;

final class LspDirectConfigReceiver {
    interface Host {
        Context systemContext();
        SharedPreferences remotePreferences() throws Throwable;
        void disconnectTransport();
        void clearSupervisionFreeze(String reason);
        void requestDirectUpload(boolean force);
        void logInfo(String message);
        void logWarn(String message);
        void logDebug(String message);
    }

    private static final String EXTRA_CONFIG_COMMAND = "command";
    private static final String COMMAND_CLEAR_SUPERVISION_FREEZE = "clear_supervision_freeze";

    private final LspDirectConfig config;
    private final String actionConfig;
    private final String configPermission;
    private final Host host;
    private volatile boolean registered = false;

    LspDirectConfigReceiver(LspDirectConfig config, String targetPackage, String configPermission, Host host) {
        this.config = config;
        this.actionConfig = targetPackage + ".LSPOSED_CONFIG";
        this.configPermission = configPermission;
        this.host = host;
    }

    void load() {
        try {
            String source = config.load(
                    host.systemContext(),
                    () -> host.remotePreferences());
            if (source.length() > 0) {
                host.logDebug("config loaded from " + source + ": enabled=" + config.enabled());
            }
        } catch (Throwable t) {
            host.logWarn("load config failed: " + t.getClass().getSimpleName());
        }
    }

    void register(Handler handler) {
        if (registered) return;
        Context context = host.systemContext();
        if (context == null) return;
        try {
            IntentFilter filter = new IntentFilter(actionConfig);
            BroadcastReceiver configReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context receiverContext, Intent intent) {
                    if (!actionConfig.equals(intent.getAction())) return;
                    String command = safeString(intent.getStringExtra(EXTRA_CONFIG_COMMAND));
                    if (COMMAND_CLEAR_SUPERVISION_FREEZE.equals(command)) {
                        host.clearSupervisionFreeze("app command");
                        return;
                    }
                    apply(receiverContext, intent);
                }
            };
            ContextCompat.registerReceiver(
                    context,
                    configReceiver,
                    filter,
                    configPermission,
                    handler,
                    ContextCompat.RECEIVER_EXPORTED);
            registered = true;
            host.logInfo("registered direct upload config receiver");
        } catch (Throwable t) {
            host.logWarn("config receiver failed: " + t.getClass().getSimpleName());
        }
    }

    private void apply(Context context, Intent intent) {
        try {
            LspDirectConfig.ApplyResult result = config.applyFromBroadcast(context, intent);
            if (result.shouldDisconnectTransport()) host.disconnectTransport();
            host.logInfo("config applied from broadcast: enabled=" + result.enabled
                    + " url=" + result.serverUrl
                    + " token=" + (result.tokenPresent ? "set" : "empty"));
            host.requestDirectUpload(true);
        } catch (Throwable t) {
            host.logWarn("save config failed: " + t.getClass().getSimpleName());
        }
    }

    private static String safeString(String value) {
        return value == null ? "" : value.trim();
    }
}
