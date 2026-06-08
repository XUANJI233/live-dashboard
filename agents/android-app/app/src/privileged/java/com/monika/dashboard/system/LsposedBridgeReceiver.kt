package com.monika.dashboard.system

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.monika.dashboard.data.DebugLog
import com.monika.dashboard.realtime.MessageSocketManager
import com.monika.dashboard.realtime.SupervisionAlertController

class LsposedBridgeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_STATUS -> handleStatus(context, intent)
            ACTION_MESSAGE -> handleMessage(context, intent)
        }
    }

    private fun handleStatus(context: Context, intent: Intent) {
        val packageName = intent.getStringExtra(EXTRA_PACKAGE)
            ?.takeIf { it.isNotBlank() && it != "idle" && it != "android" && it != "com.android.systemui" }
        val foreground = ForegroundInfo(
            packageName = packageName,
            appName = intent.getStringExtra(EXTRA_APP_NAME),
            activity = intent.getStringExtra(EXTRA_ACTIVITY),
            title = intent.getStringExtra(EXTRA_TITLE),
            source = "lsposed",
            confidence = 0.95,
        )
        val media = MediaInfo(
            playing = intent.takeIf { it.hasExtra(EXTRA_MEDIA_PLAYING) }
                ?.getBooleanExtra(EXTRA_MEDIA_PLAYING, false),
            title = intent.getStringExtra(EXTRA_MEDIA_TITLE),
            artist = intent.getStringExtra(EXTRA_MEDIA_ARTIST),
            app = intent.getStringExtra(EXTRA_MEDIA_APP)
                ?.takeIf { it.isNotBlank() && it != "android" && it != "com.milink.service" },
            packageName = intent.getStringExtra(EXTRA_MEDIA_PACKAGE)
                ?.takeIf { it.isNotBlank() && it != "android" && it != "com.milink.service" },
            state = intent.getStringExtra(EXTRA_MEDIA_STATE),
            source = "lsposed",
        )
        val snapshot = SystemSnapshot(
            capabilityMode = "lsposed",
            foreground = foreground.takeIf { it.packageName != null || it.activity != null || it.title != null },
            media = media.takeIf { it.playing != null || it.title != null || it.app != null },
        )
        SystemSnapshotStore.updateFromLsposed(snapshot)
        SupervisionAlertController.onSnapshot(context.applicationContext, snapshot)
        DebugLog.log("LSPosed", "收到系统状态事件")
    }

    private fun handleMessage(context: Context, intent: Intent) {
        val appContext = context.applicationContext
        val viewerId = intent.getStringExtra(EXTRA_VIEWER_ID).orEmpty()
        val text = intent.getStringExtra(EXTRA_TEXT).orEmpty().take(500)
        if (viewerId.isBlank() || text.isBlank()) return
        if (viewerId != "__supervisor__" && MessageSocketManager.isViewerBlocked(appContext, viewerId)) {
            DebugLog.log("LSPosed", "已忽略拉黑访客消息: $viewerId")
            return
        }
        MessageSocketManager.notifyIncoming(
            context = appContext,
            text = text,
            viewerId = viewerId,
            messageId = intent.getStringExtra(EXTRA_MESSAGE_ID).orEmpty(),
            viewerName = intent.getStringExtra(EXTRA_VIEWER_NAME).orEmpty(),
            kind = intent.getStringExtra(EXTRA_KIND).orEmpty().ifBlank { "private" },
            payloadText = intent.getStringExtra(EXTRA_PAYLOAD),
        )
        DebugLog.log("LSPosed", "收到网页访客消息")
    }

    companion object {
        const val ACTION_STATUS = "com.monika.dashboard.LSPOSED_STATUS"
        const val ACTION_MESSAGE = "com.monika.dashboard.LSPOSED_MESSAGE"
        const val EXTRA_PACKAGE = "package_name"
        const val EXTRA_APP_NAME = "app_name"
        const val EXTRA_ACTIVITY = "activity"
        const val EXTRA_TITLE = "title"
        const val EXTRA_MEDIA_PLAYING = "media_playing"
        const val EXTRA_MEDIA_PACKAGE = "media_package"
        const val EXTRA_MEDIA_TITLE = "media_title"
        const val EXTRA_MEDIA_ARTIST = "media_artist"
        const val EXTRA_MEDIA_APP = "media_app"
        const val EXTRA_MEDIA_STATE = "media_state"
        const val EXTRA_MESSAGE_ID = "message_id"
        const val EXTRA_VIEWER_ID = "viewer_id"
        const val EXTRA_VIEWER_NAME = "viewer_name"
        const val EXTRA_KIND = "kind"
        const val EXTRA_TEXT = "text"
        const val EXTRA_PAYLOAD = "payload"
    }
}
