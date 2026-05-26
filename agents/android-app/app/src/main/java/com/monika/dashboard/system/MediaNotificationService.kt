package com.monika.dashboard.system

import android.app.Notification
import android.content.pm.PackageManager
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

class MediaNotificationService : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val notification = sbn?.notification ?: return
        val extras = notification.extras ?: return
        val pkg = sbn.packageName ?: return
        if (pkg == "com.milink.service" || pkg == "com.android.systemui") return
        val isMedia = notification.category == Notification.CATEGORY_TRANSPORT ||
            extras.containsKey("android.mediaSession") ||
            extras.containsKey("android.compactActions")
        if (!isMedia) return
        val title = extras.getCharSequence("android.title")?.toString()?.takeIf { it.isNotBlank() }
        val text = extras.getCharSequence("android.text")?.toString()?.takeIf { it.isNotBlank() }
        if (title == null && text == null) return

        SystemSnapshotStore.updateFromNotification(
            MediaInfo(
                playing = true,
                title = title,
                artist = text,
                app = resolveAppName(pkg) ?: pkg,
                state = "notification",
                source = "notification",
            )
        )
    }

    private fun resolveAppName(packageName: String): String? {
        return try {
            val info = packageManager.getApplicationInfo(packageName, 0)
            packageManager.getApplicationLabel(info).toString()
        } catch (_: PackageManager.NameNotFoundException) {
            null
        } catch (_: Exception) {
            null
        }
    }
}
