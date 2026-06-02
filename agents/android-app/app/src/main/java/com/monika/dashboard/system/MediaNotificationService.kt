package com.monika.dashboard.system

import android.app.Notification
import android.content.pm.PackageManager
import android.media.session.MediaController
import android.media.session.MediaSession
import android.media.session.PlaybackState
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
        val token = extras.getParcelable<MediaSession.Token>("android.mediaSession")
        val controller = token?.let { runCatching { MediaController(this, it) }.getOrNull() }
        val playbackState = controller?.playbackState?.state
        if (playbackState != null && playbackState != PlaybackState.STATE_PLAYING) {
            SystemSnapshotStore.updateFromNotification(
                MediaInfo(
                    playing = false,
                    app = resolveAppName(pkg) ?: pkg,
                    packageName = pkg,
                    state = playbackStateName(playbackState),
                    source = "notification",
                )
            )
            return
        }
        val title = extras.getCharSequence("android.title")?.toString()?.takeIf { it.isNotBlank() }
        val text = extras.getCharSequence("android.text")?.toString()?.takeIf { it.isNotBlank() }
        if (title == null && text == null) return

        SystemSnapshotStore.updateFromNotification(
            MediaInfo(
                playing = true,
                title = title,
                artist = text,
                app = resolveAppName(pkg) ?: pkg,
                packageName = pkg,
                state = "notification",
                source = "notification",
            )
        )
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        val pkg = sbn?.packageName ?: return
        val notification = sbn.notification ?: return
        val extras = notification.extras ?: return
        val isMedia = notification.category == Notification.CATEGORY_TRANSPORT ||
            extras.containsKey("android.mediaSession") ||
            extras.containsKey("android.compactActions")
        if (!isMedia) return
        SystemSnapshotStore.updateFromNotification(
            MediaInfo(
                playing = false,
                app = resolveAppName(pkg) ?: pkg,
                packageName = pkg,
                state = "removed",
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

    private fun playbackStateName(state: Int): String = when (state) {
        PlaybackState.STATE_PLAYING -> "playing"
        PlaybackState.STATE_PAUSED -> "paused"
        PlaybackState.STATE_STOPPED -> "stopped"
        PlaybackState.STATE_BUFFERING -> "buffering"
        else -> "state_$state"
    }
}
