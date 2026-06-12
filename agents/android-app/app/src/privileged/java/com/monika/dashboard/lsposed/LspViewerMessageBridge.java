package com.monika.dashboard.lsposed;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Binder;

import org.json.JSONObject;

final class LspViewerMessageBridge {
    interface Host {
        Context systemContext();
        void logDebug(String message);
    }

    private final String actionMessage;
    private final String targetPackage;
    private final String targetReceiver;
    private final String configPermission;
    private final LspDeviceCommandController deviceCommandController;
    private final LspNotificationCenter notificationCenter;
    private final Host host;

    LspViewerMessageBridge(
            String targetPackage,
            String targetReceiver,
            String configPermission,
            LspDeviceCommandController deviceCommandController,
            LspNotificationCenter notificationCenter,
            Host host) {
        this.actionMessage = targetPackage + ".LSPOSED_MESSAGE";
        this.targetPackage = targetPackage;
        this.targetReceiver = targetReceiver;
        this.configPermission = configPermission;
        this.deviceCommandController = deviceCommandController;
        this.notificationCenter = notificationCenter;
        this.host = host;
    }

    void handleWsTextMessage(String payloadText) {
        if (deviceCommandController.handleServerAck(payloadText)) return;
        if (deviceCommandController.handleIncomingText(payloadText, "ws")) return;
        forwardToApp(payloadText);
    }

    void forwardToApp(String payloadText) {
        try {
            JSONObject data = new JSONObject(payloadText);
            if (!"viewer_message".equals(data.optString("type"))) return;
            String viewerId = data.optString("viewer_id", "");
            String text = data.optString("text", "");
            if (viewerId.length() == 0 || text.length() == 0) return;
            JSONObject payload = data.optJSONObject("payload");
            if (payload != null && LspDeviceCommandProtocol.TYPE_COMMAND.equals(payload.optString("type"))) {
                deviceCommandController.handleCommand(payload, "viewer_payload");
                return;
            }

            Intent intent = new Intent(actionMessage);
            intent.setComponent(new ComponentName(targetPackage, targetReceiver));
            intent.putExtra("message_id", data.optString("message_id", ""));
            intent.putExtra("viewer_id", viewerId);
            intent.putExtra("viewer_name", data.optString("viewer_name", ""));
            intent.putExtra("kind", data.optString("kind", "private"));
            intent.putExtra("text", text);
            if (payload != null) intent.putExtra("payload", payload.toString());

            Context ctx = host.systemContext();
            if (ctx == null) return;
            long token = Binder.clearCallingIdentity();
            try {
                ctx.sendBroadcast(intent, configPermission);
                postNotification(ctx, data, text, viewerId);
            } finally {
                Binder.restoreCallingIdentity(token);
            }
            host.logDebug("forwarded viewer message to app: " + viewerId);
        } catch (Throwable t) {
            host.logDebug("viewer message forward ignored: " + t.getClass().getSimpleName());
        }
    }

    private void postNotification(Context ctx, JSONObject data, String text, String viewerId) {
        try {
            notificationCenter.postViewerMessage(ctx, data.optString("message_id", viewerId), text, viewerId);
        } catch (Throwable t) {
            host.logDebug("LSP message notification skipped: " + t.getClass().getSimpleName());
        }
    }
}
