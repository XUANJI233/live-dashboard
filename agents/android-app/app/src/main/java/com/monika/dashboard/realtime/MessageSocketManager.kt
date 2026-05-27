package com.monika.dashboard.realtime

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.monika.dashboard.MainActivity
import com.monika.dashboard.R
import com.monika.dashboard.data.DebugLog
import com.monika.dashboard.data.MessageInboxStore
import com.monika.dashboard.data.SettingsStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URI
import java.util.concurrent.TimeUnit

object MessageSocketManager {
    private const val CHANNEL_ID = "visitor_messages"
    private const val NOTIFICATION_ID = 2001
    private const val PREFS = "message_controls"
    const val ACTION_BLOCK_VIEWER = "com.monika.dashboard.action.BLOCK_VIEWER"
    const val EXTRA_VIEWER_ID = "viewer_id"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val client = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .build()

    @Volatile
    private var socket: WebSocket? = null

    @Volatile
    private var connecting = false

    fun ensureStarted(context: Context) {
        if (socket != null || connecting) return
        val appContext = context.applicationContext
        connecting = true
        scope.launch {
            val settings = SettingsStore(appContext)
            val enabled = settings.monitoringEnabled.first()
            val url = settings.serverUrl.first()
            val token = settings.getToken()
            if (!enabled || url.isBlank() || token.isNullOrBlank()) {
                connecting = false
                return@launch
            }
            runCatching {
                val wsUrl = buildWsUrl(url)
                val request = Request.Builder()
                    .url(wsUrl)
                    .addHeader("Authorization", "Bearer $token")
                    .build()
                socket = client.newWebSocket(request, Listener(appContext, url, token))
            }.onFailure {
                connecting = false
                DebugLog.log("消息", "WebSocket启动失败: ${it.message}")
            }
        }
    }

    fun stop() {
        socket?.close(1000, "disabled")
        socket = null
        connecting = false
    }

    fun isViewerBlocked(context: Context, viewerId: String): Boolean {
        if (viewerId.isBlank()) return false
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getStringSet("blocked_viewers", emptySet())
            ?.contains(viewerId) == true
    }

    fun blockViewer(context: Context, viewerId: String) {
        if (viewerId.isBlank()) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val current = prefs.getStringSet("blocked_viewers", emptySet()).orEmpty()
        prefs.edit().putStringSet("blocked_viewers", current + viewerId).apply()
        DebugLog.log("消息", "已拉黑访客: $viewerId")
    }

    fun unblockViewer(context: Context, viewerId: String) {
        if (viewerId.isBlank()) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val current = prefs.getStringSet("blocked_viewers", emptySet()).orEmpty()
        prefs.edit().putStringSet("blocked_viewers", current - viewerId).apply()
        DebugLog.log("消息", "已解除拉黑访客: $viewerId")
    }

    fun blockedViewers(context: Context): Set<String> =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getStringSet("blocked_viewers", emptySet())
            .orEmpty()

    fun notifyIncoming(
        context: Context,
        text: String,
        viewerId: String? = null,
        messageId: String = "",
        viewerName: String = "",
        kind: String = "private",
    ) {
        if (!viewerId.isNullOrBlank()) {
            MessageInboxStore.add(context, messageId, viewerId, text, viewerName, kind, "viewer")
        }
        createChannel(context)
        val intent = Intent(context, MainActivity::class.java)
        val pending = PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("网页游客消息")
            .setContentText(text.take(120))
            .setStyle(NotificationCompat.BigTextStyle().bigText(text.take(500)))
            .setContentIntent(pending)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setAutoCancel(true)
        if (!viewerId.isNullOrBlank()) {
            val blockIntent = Intent(context, MessageActionReceiver::class.java).apply {
                action = ACTION_BLOCK_VIEWER
                putExtra(EXTRA_VIEWER_ID, viewerId)
            }
            val blockPending = PendingIntent.getBroadcast(
                context,
                viewerId.hashCode(),
                blockIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            builder.addAction(R.mipmap.ic_launcher, "拉黑访客", blockPending)
        }
        val notification = builder.build()
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, notification)
    }

    private fun buildWsUrl(serverUrl: String): String {
        val base = serverUrl.trimEnd('/')
        val wsBase = if (base.startsWith("https", ignoreCase = true)) {
            base.replace(Regex("^https://", RegexOption.IGNORE_CASE), "wss://")
        } else if (base.startsWith("http", ignoreCase = true)) {
            base.replace(Regex("^http://", RegexOption.IGNORE_CASE), "ws://")
        } else {
            "wss://$base"
        }
        return "$wsBase/api/ws?role=device"
    }

    private fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "网页游客消息",
                NotificationManager.IMPORTANCE_HIGH
            )
        )
    }

    private class Listener(
        private val context: Context,
        private val serverUrl: String,
        private val token: String,
    ) : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            connecting = false
            DebugLog.log("消息", "WebSocket已连接")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val data = runCatching { JSONObject(text) }.getOrNull() ?: return
            if (data.optString("type") != "viewer_message") return
            val message = data.optString("text").take(500)
            val messageId = data.optString("message_id")
            val viewerId = data.optString("viewer_id")
            val viewerName = data.optString("viewer_name")
            val kind = data.optString("kind", "private")
            if (isViewerBlocked(context, viewerId)) {
                DebugLog.log("消息", "已忽略拉黑访客消息: $viewerId")
                return
            }
            notifyIncoming(context, message, viewerId, messageId, viewerName, kind)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            socket = null
            connecting = false
            DebugLog.log("消息", "WebSocket已断开")
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            socket = null
            connecting = false
            DebugLog.log("消息", "WebSocket失败: ${t.message}")
        }
    }
}
