package com.monika.dashboard.system

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

class MediaNotificationService : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val notification = sbn?.notification ?: return
        val extras = notification.extras ?: return
        val title = extras.getCharSequence("android.title")?.toString()?.takeIf { it.isNotBlank() }
        val text = extras.getCharSequence("android.text")?.toString()?.takeIf { it.isNotBlank() }
        val pkg = sbn.packageName
        if (title == null && text == null) return

        SystemSnapshotStore.updateFromNotification(
            MediaInfo(
                playing = true,
                title = title,
                artist = text,
                app = pkg,
                state = "notification",
                source = "notification",
            )
        )
    }
}
