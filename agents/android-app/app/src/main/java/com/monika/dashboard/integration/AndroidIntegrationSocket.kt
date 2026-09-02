package com.monika.dashboard.integration

import android.content.Context
import com.monika.dashboard.coyote.CoyoteBleController
import com.monika.dashboard.data.DebugLog
import com.monika.dashboard.data.SettingsStore
import java.time.Duration
import java.time.Instant
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

object AndroidIntegrationSocket {
    private const val BASE_RECONNECT_DELAY_MS = 10_000L
    private const val MAX_RECONNECT_DELAY_MS = 300_000L
    private const val STATUS_MIN_INTERVAL_MS = 1_000L
    private const val MAX_ACCOUNTING_RANGE_DAYS = 3_650L

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val client = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private val generation = AtomicLong(0)

    @Volatile private var appContext: Context? = null
    @Volatile private var socket: WebSocket? = null
    @Volatile private var connecting = false
    @Volatile private var stopped = true
    @Volatile private var reconnectAttempts = 0
    @Volatile private var lastStatusAt = 0L
    @Volatile private var accountingAvailable = false
    @Volatile private var stateCollectionStarted = false

    fun start(context: Context) {
        appContext = context.applicationContext
        stopped = false
        CoyoteBleController.initialize(context)
        if (!stateCollectionStarted) {
            stateCollectionStarted = true
            scope.launch {
                CoyoteBleController.state.collectLatest {
                    val now = System.currentTimeMillis()
                    if (now - lastStatusAt >= STATUS_MIN_INTERVAL_MS) sendStatus()
                }
            }
        }
        ensureConnected()
        scope.launch {
            accountingAvailable = AutoAccountingClient().healthCheck()
            sendStatus()
        }
    }

    fun stop() {
        stopped = true
        generation.incrementAndGet()
        socket?.close(1000, "integration stopped")
        socket = null
        connecting = false
    }

    fun sendStatus() {
        val context = appContext ?: return
        val preferences = AndroidIntegrationPreferences(context)
        val payload = JSONObject().apply {
            put("type", "integration_status")
            put("coyote", CoyoteBleController.state.value.toJson())
            put(
                "accounting",
                JSONObject().apply {
                    put("available", accountingAvailable)
                    put("last_sync_at", preferences.accountingLastSyncAt)
                    put("last_error", preferences.accountingLastError)
                },
            )
        }
        if (socket?.send(payload.toString()) == true) lastStatusAt = System.currentTimeMillis()
    }

    private fun ensureConnected() {
        if (stopped || socket != null || connecting) return
        val context = appContext ?: return
        val currentGeneration = generation.incrementAndGet()
        connecting = true
        scope.launch {
            val connected = runCatching {
                val settings = SettingsStore(context)
                val serverUrl = settings.serverUrl.first()
                val token = settings.getToken().orEmpty()
                check(serverUrl.isNotBlank() && token.isNotBlank()) { "请先配置服务器和 Token" }
                val request = Request.Builder()
                    .url(integrationWebSocketUrl(serverUrl))
                    .header("Authorization", "Bearer $token")
                    .build()
                if (!isCurrent(currentGeneration)) return@launch
                val next = client.newWebSocket(request, Listener(currentGeneration))
                if (!isCurrent(currentGeneration)) next.cancel() else socket = next
            }
            connected.exceptionOrNull()?.let { error ->
                connecting = false
                DebugLog.log("设备集成", "WebSocket启动失败: ${error.message.orEmpty()}")
                scheduleReconnect(currentGeneration)
            }
        }
    }

    private fun handleMessage(webSocket: WebSocket, text: String) {
        val data = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (data.optString("type")) {
            "ack" -> if (data.optString("role") == "integration") sendStatus()
            "integration_status_request" -> sendStatus()
            "coyote_command" -> handleCoyoteCommand(webSocket, data)
            "accounting_sync_request" -> handleAccountingSync(webSocket, data)
        }
    }

    private fun handleCoyoteCommand(webSocket: WebSocket, data: JSONObject) {
        val requestId = cleanRequestId(data.optString("request_id"))
        val command = data.optJSONObject("command") ?: JSONObject()
        scope.launch {
            val result = CoyoteBleController.executeRemote(command)
            result.put("type", "coyote_command_result")
            result.put("request_id", requestId)
            webSocket.send(result.toString())
            sendStatus()
        }
    }

    private fun handleAccountingSync(webSocket: WebSocket, data: JSONObject) {
        val context = appContext ?: return
        val requestId = cleanRequestId(data.optString("request_id"))
        scope.launch {
            val result = runCatching {
                val start = Instant.parse(data.optString("start"))
                val end = Instant.parse(data.optString("end"))
                require(end.isAfter(start)) { "账单查询时间范围无效" }
                require(Duration.between(start, end).toDays() <= MAX_ACCOUNTING_RANGE_DAYS) { "账单查询时间范围过大" }
                AccountingSyncCoordinator(context).sync(start, end)
            }.getOrElse { error ->
                AccountingSyncResult(
                    available = false,
                    fetched = 0,
                    accepted = 0,
                    skipped = 0,
                    completedAt = Instant.now().toString(),
                    error = error.message.orEmpty().ifBlank { "账单同步失败" }.take(240),
                )
            }
            accountingAvailable = result.available
            val response = result.toJson().apply {
                put("type", "accounting_sync_result")
                put("request_id", requestId)
                put("ok", result.error.isBlank())
                put("status", if (result.error.isBlank()) "applied" else "failed")
                put("accounting", result.toJson())
            }
            webSocket.send(response.toString())
            sendStatus()
        }
    }

    private fun scheduleReconnect(expectedGeneration: Long) {
        if (!isCurrent(expectedGeneration)) return
        scope.launch {
            val exponent = reconnectAttempts.coerceAtMost(5)
            val waitMs = (BASE_RECONNECT_DELAY_MS * (1L shl exponent)).coerceAtMost(MAX_RECONNECT_DELAY_MS)
            reconnectAttempts = (reconnectAttempts + 1).coerceAtMost(30)
            delay(waitMs)
            if (isCurrent(expectedGeneration)) {
                socket = null
                connecting = false
                ensureConnected()
            }
        }
    }

    private fun isCurrent(expectedGeneration: Long): Boolean = !stopped && generation.get() == expectedGeneration

    private fun integrationWebSocketUrl(serverUrl: String): String {
        val base = serverUrl.trim().trimEnd('/')
        return when {
            base.startsWith("https://") -> "wss://${base.removePrefix("https://")}/api/ws?role=integration"
            base.startsWith("http://") -> "ws://${base.removePrefix("http://")}/api/ws?role=integration"
            else -> throw IllegalArgumentException("服务器地址必须是 HTTPS 或 localhost HTTP")
        }
    }

    private fun cleanRequestId(value: String): String = value
        .replace(Regex("[\\u0000-\\u001f\\u007f]"), "")
        .trim()
        .take(160)
        .takeIf { it.matches(Regex("[a-zA-Z0-9_.:-]{1,160}")) }
        .orEmpty()

    private class Listener(private val expectedGeneration: Long) : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (!isCurrent(expectedGeneration)) {
                webSocket.cancel()
                return
            }
            socket = webSocket
            connecting = false
            reconnectAttempts = 0
            DebugLog.log("设备集成", "WebSocket已连接")
            sendStatus()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (isCurrent(expectedGeneration)) handleMessage(webSocket, text)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (!isCurrent(expectedGeneration)) return
            if (socket === webSocket) socket = null
            connecting = false
            scheduleReconnect(expectedGeneration)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (!isCurrent(expectedGeneration)) return
            if (socket === webSocket) socket = null
            connecting = false
            DebugLog.log("设备集成", "WebSocket失败: ${t.message.orEmpty()}")
            scheduleReconnect(expectedGeneration)
        }
    }
}
