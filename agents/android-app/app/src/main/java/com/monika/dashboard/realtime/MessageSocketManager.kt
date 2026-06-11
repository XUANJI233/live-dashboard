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
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicLong

object MessageSocketManager {
    private const val CHANNEL_ID = "visitor_messages"
    private const val NOTIFICATION_ID = 2001
    private const val PREFS = "message_controls"
    private const val BASE_RECONNECT_DELAY_MS = 10_000L
    private const val MAX_RECONNECT_DELAY_MS = 300_000L // 5 minutes max
    private const val TYPE_AI_REQUEST_ACK = "ai_request_ack"
    private const val TYPE_AI_JOB_UPDATE = "ai_job_update"
    private const val MAX_AI_JOB_CACHE = 40
    const val EXTRA_DESTINATION = "destination"
    const val EXTRA_MESSAGES_SECTION = "messages_section"
    const val DESTINATION_MESSAGES = "messages"
    const val MESSAGES_SECTION_PRIVATE = "private"
    @Volatile
    private var reconnectAttempts = 0
    const val ACTION_BLOCK_VIEWER = "com.monika.dashboard.action.BLOCK_VIEWER"
    const val EXTRA_VIEWER_ID = "viewer_id"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val client = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .build()
    private val aiAckWaiters = ConcurrentHashMap<String, CompletableFuture<JSONObject>>()
    private val aiJobWaiters = ConcurrentHashMap<String, CompletableFuture<JSONObject>>()
    private val latestAiJobs = ConcurrentHashMap<String, JSONObject>()

    @Volatile
    private var socket: WebSocket? = null

    @Volatile
    private var connecting = false

    @Volatile
    private var connected = false

    @Volatile
    private var stopped = false

    private val connectionGeneration = AtomicLong(0L)

    fun isConnected(): Boolean = connected

    // OkHttp pingInterval=25s handles keepalive; connected implies healthy
    fun isHealthy(): Boolean = connected

    /**
     * Send a device_status message over the WebSocket.
     * Returns true if the message was queued for sending, false if WS is not connected.
     */
    fun sendDeviceStatus(jsonPayload: String): Boolean {
        val ws = socket
        if (ws == null || !connected) {
            DebugLog.log("消息", "WS未连接，跳过device_status发送")
            return false
        }
        return try {
            val msg = JSONObject().apply {
                put("type", "device_status")
                put("payload", JSONObject(jsonPayload))
            }
            val queued = ws.send(msg.toString())
            DebugLog.log("消息", if (queued) "WS发送device_status成功" else "WS发送device_status未入队")
            queued
        } catch (e: Exception) {
            DebugLog.log("消息", "WS发送device_status失败: ${e.message}")
            false
        }
    }

    fun sendDeviceCommandEvent(event: JSONObject): Boolean {
        val ws = socket
        if (ws == null || !connected) return false
        return try {
            ws.send(event.toString())
        } catch (_: Exception) {
            false
        }
    }

    fun sendAiRequest(request: JSONObject, ackTimeoutMs: Long): JSONObject? {
        val requestId = cleanAiRequestId(request.optString("request_id"))
        if (requestId.isBlank()) return null
        val ws = socket
        if (ws == null || !connected) return null
        val future = CompletableFuture<JSONObject>()
        aiAckWaiters[requestId] = future
        return try {
            if (!ws.send(request.toString())) return null
            future.get(ackTimeoutMs.coerceAtLeast(250L), TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
            null
        } catch (_: Exception) {
            null
        } finally {
            aiAckWaiters.remove(requestId)
        }
    }

    fun waitForAiJob(requestId: String, timeoutMs: Long): JSONObject? {
        val cleanRequestId = cleanAiRequestId(requestId)
        if (cleanRequestId.isBlank()) return null
        latestAiJobs[cleanRequestId]?.let { latest ->
            if (isTerminalAiJob(latest)) return latest
        }
        val future = CompletableFuture<JSONObject>()
        aiJobWaiters[cleanRequestId] = future
        latestAiJobs[cleanRequestId]?.let { latest ->
            if (isTerminalAiJob(latest)) {
                aiJobWaiters.remove(cleanRequestId)
                return latest
            }
        }
        return try {
            future.get(timeoutMs.coerceAtLeast(250L), TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
            null
        } catch (_: Exception) {
            null
        } finally {
            aiJobWaiters.remove(cleanRequestId)
        }
    }

    fun ensureStarted(context: Context) {
        if (socket != null || connecting) return
        val appContext = context.applicationContext
        val generation = connectionGeneration.incrementAndGet()
        stopped = false
        connecting = true
        scope.launch {
            try {
                val settings = SettingsStore(appContext)
                val enabled = settings.monitoringEnabled.first()
                val url = settings.serverUrl.first()
                val token = settings.getToken()
                if (!canOpenSocket(enabled, url, token, generation)) {
                    connecting = false
                    return@launch
                }
                val cleanToken = token.orEmpty()
                val wsUrl = buildWsUrl(url)
                val request = Request.Builder()
                    .url(wsUrl)
                    .addHeader("Authorization", "Bearer $cleanToken")
                    .build()
                val nextSocket = client.newWebSocket(request, Listener(appContext, url, cleanToken, generation))
                socket = nextSocket
                if (!isCurrentStart(generation)) {
                    nextSocket.close(1000, "disabled")
                    clearSocketIfCurrent(nextSocket)
                    connecting = false
                }
            } catch (e: Exception) {
                connecting = false
                DebugLog.log("消息", "WebSocket启动失败: ${e.message}")
            }
        }
    }

    fun stop() {
        connectionGeneration.incrementAndGet()
        stopped = true
        socket?.close(1000, "disabled")
        socket = null
        connecting = false
        connected = false
        reconnectAttempts = 0
    }

    private fun isCurrentStart(generation: Long): Boolean =
        !stopped && connectionGeneration.get() == generation

    private fun canOpenSocket(enabled: Boolean, url: String, token: String?, generation: Long): Boolean =
        enabled && url.isNotBlank() && !token.isNullOrBlank() && isCurrentStart(generation)

    private fun clearSocketIfCurrent(webSocket: WebSocket) {
        if (socket === webSocket) socket = null
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
        payloadText: String? = null,
    ) {
        if (DeviceCommandController.handlePayloadText(context.applicationContext, payloadText, source = "message_payload")) {
            return
        }
        if (!viewerId.isNullOrBlank() && kind != "public") {
            MessageInboxStore.add(
                context = context,
                id = messageId,
                viewerId = viewerId,
                text = text,
                viewerName = viewerName,
                kind = kind,
                direction = "viewer",
            )
        }
        createChannel(context)
        val intent = Intent(context, MainActivity::class.java)
            .putExtra(EXTRA_DESTINATION, DESTINATION_MESSAGES)
            .putExtra(EXTRA_MESSAGES_SECTION, MESSAGES_SECTION_PRIVATE)
            .putExtra(EXTRA_VIEWER_ID, viewerId.orEmpty())
            .putExtra("message_id", messageId)
        val requestCode = notificationId(messageId, viewerId)
        val pending = PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(if (viewerId == "__supervisor__") "监督模式" else "网页访客消息")
            .setContentText(text.take(120))
            .setStyle(NotificationCompat.BigTextStyle().bigText(text.take(500)))
            .setContentIntent(pending)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setAutoCancel(true)
        if (!viewerId.isNullOrBlank() && viewerId != "__supervisor__") {
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
        nm.notify(requestCode, notification)
    }

    private fun notificationId(messageId: String, viewerId: String?): Int {
        val key = messageId.ifBlank { viewerId.orEmpty() }.ifBlank { System.currentTimeMillis().toString() }
        return NOTIFICATION_ID + (key.hashCode() and 0x00ffffff)
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
                "网页访客消息",
                NotificationManager.IMPORTANCE_HIGH
            )
        )
    }

    private fun handleAiRequestAck(data: JSONObject): Boolean {
        if (data.optString("type") != TYPE_AI_REQUEST_ACK) return false
        val requestId = cleanAiRequestId(data.optString("request_id"))
        if (requestId.isNotBlank()) aiAckWaiters.remove(requestId)?.complete(JSONObject(data.toString()))
        return true
    }

    private fun handleAiJobUpdate(data: JSONObject): Boolean {
        if (data.optString("type") != TYPE_AI_JOB_UPDATE) return false
        val job = data.optJSONObject("job") ?: return true
        val requestId = cleanAiRequestId(job.optString("request_id"))
        if (requestId.isBlank()) return true
        val snapshot = JSONObject(job.toString())
        latestAiJobs[requestId] = snapshot
        trimAiJobCache()
        if (isTerminalAiJob(snapshot)) aiJobWaiters.remove(requestId)?.complete(snapshot)
        return true
    }

    private fun isTerminalAiJob(job: JSONObject): Boolean =
        job.optString("status") == "succeeded" || job.optString("status") == "failed"

    private fun trimAiJobCache() {
        val overflow = latestAiJobs.size - MAX_AI_JOB_CACHE
        if (overflow <= 0) return
        latestAiJobs.keys.take(overflow).forEach { latestAiJobs.remove(it) }
    }

    private fun cleanAiRequestId(value: String): String =
        value.replace(Regex("[\\u0000-\\u001f\\u007f]"), "")
            .trim()
            .take(160)
            .takeIf { it.matches(Regex("[a-zA-Z0-9_.:-]{1,160}")) }
            .orEmpty()

    private class Listener(
        private val context: Context,
        private val serverUrl: String,
        private val token: String,
        private val generation: Long,
    ) : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (!isCurrentStart(generation)) {
                webSocket.close(1000, "disabled")
                clearSocketIfCurrent(webSocket)
                connecting = false
                return
            }
            connecting = false
            connected = true
            reconnectAttempts = 0 // Reset backoff on successful connection
            DebugLog.log("消息", "WebSocket已连接")
            DeviceCommandController.flushPending(context)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (!isCurrentStart(generation)) return
            // Ignore ack pings at app level — keepalive is handled by WS protocol ping/pong
            val data = runCatching { JSONObject(text) }.getOrNull() ?: return
            if (data.optString("type") == "ack") return
            if (handleAiRequestAck(data)) return
            if (handleAiJobUpdate(data)) return
            if (DeviceCommandController.handleServerAck(context, data)) return
            if (DeviceCommandController.handleIncoming(context, data, source = "ws")) return
            if (data.optString("type") != "viewer_message") return
            val message = data.optString("text").take(500)
            val messageId = data.optString("message_id")
            val viewerId = data.optString("viewer_id")
            val viewerName = data.optString("viewer_name")
            val kind = data.optString("kind", "private")
            val payload = data.optJSONObject("payload")
            if (DeviceCommandController.handleIncoming(context, payload ?: JSONObject(), source = "ws_payload")) return
            if (viewerId != "__supervisor__" && isViewerBlocked(context, viewerId)) {
                DebugLog.log("消息", "已忽略拉黑访客消息: $viewerId")
                return
            }
            notifyIncoming(context, message, viewerId, messageId, viewerName, kind, payload?.toString())
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (connectionGeneration.get() != generation) return
            clearSocketIfCurrent(webSocket)
            connecting = false
            connected = false
            DebugLog.log("消息", "WebSocket已断开 (code=$code)")
            scheduleReconnect()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (connectionGeneration.get() != generation) return
            clearSocketIfCurrent(webSocket)
            connecting = false
            connected = false
            DebugLog.log("消息", "WebSocket失败: ${t.message}")
            scheduleReconnect()
        }

        private fun scheduleReconnect() {
            if (!isCurrentStart(generation)) return
            scope.launch {
                val exponent = reconnectAttempts.coerceAtMost(5)
                val delayMs = (BASE_RECONNECT_DELAY_MS * (1L shl exponent)).coerceAtMost(MAX_RECONNECT_DELAY_MS)
                reconnectAttempts = (reconnectAttempts + 1).coerceAtMost(30)
                delay(delayMs)
                if (!isCurrentStart(generation) || socket != null || connecting) return@launch
                DebugLog.log("消息", "WebSocket尝试重连... (attempt $reconnectAttempts, delay ${delayMs}ms)")
                connecting = true
                runCatching {
                    val wsUrl = buildWsUrl(serverUrl)
                    val request = Request.Builder()
                        .url(wsUrl)
                        .addHeader("Authorization", "Bearer $token")
                        .build()
                    val nextSocket = client.newWebSocket(request, this@Listener)
                    socket = nextSocket
                    if (!isCurrentStart(generation)) {
                        nextSocket.close(1000, "disabled")
                        clearSocketIfCurrent(nextSocket)
                        connecting = false
                    }
                }.onFailure {
                    connecting = false
                    DebugLog.log("消息", "WebSocket重连失败: ${it.message}")
                    scheduleReconnect() // retry with increased backoff
                }
            }
        }
    }
}
