package com.monika.dashboard.lsposed;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

final class LspNotificationCenter {
    private static final String MESSAGE_CHANNEL_ID = "monika_lsp_messages";
    private static final int MESSAGE_NOTIFICATION_ID = 2002;
    private static final String SUPERVISION_CHANNEL_ID = "monika_lsp_supervision";
    private static final int SUPERVISION_FREEZE_NOTIFICATION_ID = 2003;
    private static final int SUPERVISION_ALERT_NOTIFICATION_ID = 2004;

    private final String targetPackage;

    LspNotificationCenter(String targetPackage) {
        this.targetPackage = targetPackage;
    }

    void postSupervisionFreeze(
            Context ctx,
            String packageName,
            String appName,
            String reason,
            String untilText) {
        NotificationManager nm = notificationManager(ctx);
        if (nm == null) return;
        ensureSupervisionChannel(nm);

        String safeAppName = safeString(appName);
        String label = safeAppName.length() > 0 ? safeAppName : safeString(packageName);
        String body = safeString(reason);
        if (body.length() == 0) body = "监督模式已冻结该应用";
        body = body + "。自动统一解冻时间：" + safeString(untilText);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(ctx, SUPERVISION_CHANNEL_ID)
                : new Notification.Builder(ctx);
        builder.setSmallIcon(android.R.drawable.stat_sys_warning)
                .setContentTitle("已冻结 " + label)
                .setContentText(limit(body, 120))
                .setStyle(new Notification.BigTextStyle().bigText(limit(body, 500)))
                .setOngoing(true)
                .setAutoCancel(false)
                .setShowWhen(true)
                .setWhen(System.currentTimeMillis())
                .setCategory(Notification.CATEGORY_STATUS)
                .setPriority(Notification.PRIORITY_HIGH)
                .setDefaults(Notification.DEFAULT_VIBRATE)
                .setVisibility(Notification.VISIBILITY_PUBLIC);
        nm.notify(notificationId("freeze:" + safeString(packageName), SUPERVISION_FREEZE_NOTIFICATION_ID), builder.build());
    }

    boolean postDeviceCommandSay(Context ctx, String commandId, String text) {
        NotificationManager nm = notificationManager(ctx);
        if (nm == null) return false;
        ensureSupervisionChannel(nm);

        String messageId = safeString(commandId);
        PendingIntent pendingIntent = buildLaunchPendingIntent(ctx, messageId, "__supervisor__");
        String body = safeString(text);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(ctx, SUPERVISION_CHANNEL_ID)
                : new Notification.Builder(ctx);
        builder.setSmallIcon(android.R.drawable.stat_sys_warning)
                .setContentTitle("监督模式")
                .setContentText(limit(body, 120))
                .setStyle(new Notification.BigTextStyle().bigText(limit(body, 500)))
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .setShowWhen(true)
                .setWhen(System.currentTimeMillis())
                .setCategory(Notification.CATEGORY_STATUS)
                .setPriority(Notification.PRIORITY_HIGH)
                .setVisibility(Notification.VISIBILITY_PUBLIC);
        nm.notify(notificationId("device-command:" + messageId, SUPERVISION_ALERT_NOTIFICATION_ID), builder.build());
        return true;
    }

    void postViewerMessage(Context ctx, String messageId, String text, String viewerId) {
        NotificationManager nm = notificationManager(ctx);
        if (nm == null) return;
        ensureMessageChannel(nm);

        PendingIntent pendingIntent = buildLaunchPendingIntent(ctx, messageId, viewerId);
        String body = safeString(text);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(ctx, MESSAGE_CHANNEL_ID)
                : new Notification.Builder(ctx);
        builder.setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle("网页访客消息")
                .setContentText(limit(body, 120))
                .setStyle(new Notification.BigTextStyle().bigText(limit(body, 500)))
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .setShowWhen(true)
                .setWhen(System.currentTimeMillis())
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setPriority(Notification.PRIORITY_HIGH)
                .setDefaults(Notification.DEFAULT_VIBRATE | Notification.DEFAULT_SOUND)
                .setVisibility(Notification.VISIBILITY_PUBLIC);
        nm.notify(notificationId(safeString(messageId).length() > 0 ? messageId : viewerId, MESSAGE_NOTIFICATION_ID), builder.build());
    }

    void cancelSupervisionFreeze(Context ctx, String packageName) {
        NotificationManager nm = notificationManager(ctx);
        if (nm == null) return;
        nm.cancel(notificationId("freeze:" + safeString(packageName), SUPERVISION_FREEZE_NOTIFICATION_ID));
    }

    private NotificationManager notificationManager(Context ctx) {
        if (ctx == null) return null;
        return (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
    }

    private void ensureSupervisionChannel(NotificationManager nm) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                SUPERVISION_CHANNEL_ID,
                "Monika 监督",
                NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("监督模式提醒和冻结状态");
        nm.createNotificationChannel(channel);
    }

    private void ensureMessageChannel(NotificationManager nm) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                MESSAGE_CHANNEL_ID,
                "Monika网页消息",
                NotificationManager.IMPORTANCE_HIGH);
        nm.createNotificationChannel(channel);
    }

    private PendingIntent buildLaunchPendingIntent(Context ctx, String messageId, String viewerId) {
        Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(targetPackage);
        if (launch == null) {
            launch = new Intent();
            launch.setComponent(new ComponentName(targetPackage, "com.monika.dashboard.MainActivity"));
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        launch.putExtra("destination", "messages");
        launch.putExtra("messages_section", "private");
        launch.putExtra("viewer_id", safeString(viewerId));
        launch.putExtra("message_id", safeString(messageId));

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        String requestKey = safeString(messageId).length() > 0 ? messageId : viewerId;
        return PendingIntent.getActivity(
                ctx,
                notificationId(requestKey, MESSAGE_NOTIFICATION_ID),
                launch,
                flags);
    }

    private static int notificationId(String key, int fallback) {
        String value = safeString(key);
        if (value.length() == 0) return fallback;
        return fallback + (value.hashCode() & 0x00ffffff);
    }

    private static String limit(String value, int maxLength) {
        String safe = safeString(value);
        return safe.length() > maxLength ? safe.substring(0, maxLength) : safe;
    }

    private static String safeString(String value) {
        return value == null ? "" : value.trim();
    }
}
