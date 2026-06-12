package com.monika.dashboard.realtime

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import com.monika.dashboard.data.DebugLog
import com.monika.dashboard.data.MessageInboxStore
import com.monika.dashboard.data.SettingsStore
import com.monika.dashboard.network.ReportClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

object DeviceCommandController {
    private const val TYPE_COMMAND = "device_command"
    private const val TYPE_RECEIPT_ACK = "device_command_receipt_received"
    private const val TYPE_RESULT_ACK = "device_command_result_received"
    private const val KIND_SUPERVISION = "supervision"
    private const val KIND_SUPERVISION_POLICY = "supervision_policy"
    private const val RESULT_APPLIED = "applied"
    private const val RESULT_PARTIAL = "partial"
    private const val RESULT_FAILED = "failed"
    private const val RESULT_UNSUPPORTED = "unsupported"
    private const val RESULT_IGNORED = "ignored"
    private const val RESULT_EXPIRED = "expired"
    private const val VIBRATION_MS = 650L
    private const val WS_EVENT_ACK_FALLBACK_MS = 4_000L

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val inFlightCommands = ConcurrentHashMap.newKeySet<String>()

    fun isDeviceCommand(payloadText: String?): Boolean =
        parseObject(payloadText)?.optString("type") == TYPE_COMMAND

    fun isDeviceCommand(payload: JSONObject?): Boolean =
        payload?.optString("type") == TYPE_COMMAND

    fun handlePayloadText(context: Context, payloadText: String?, source: String): Boolean {
        val payload = parseObject(payloadText) ?: return false
        return handleIncoming(context, payload, source)
    }

    fun handleIncoming(context: Context, command: JSONObject, source: String): Boolean {
        if (!isDeviceCommand(command)) return false
        val appContext = context.applicationContext
        scope.launch {
            processCommand(appContext, command, source)
        }
        return true
    }

    fun handleServerAck(context: Context, data: JSONObject): Boolean {
        return when (data.optString("type")) {
            TYPE_RECEIPT_ACK -> {
                if (data.strictBoolean("received", false)) {
                    DeviceCommandStore.removePending(context, receiptEventKey(data.optString("command_id")))
                }
                true
            }
            TYPE_RESULT_ACK -> {
                if (data.strictBoolean("received", false)) {
                    DeviceCommandStore.removePending(
                        context,
                        resultEventKey(data.optString("command_id"), data.optString("result_id")),
                    )
                }
                true
            }
            else -> false
        }
    }

    fun flushPending(context: Context) {
        val appContext = context.applicationContext
        scope.launch {
            flushPendingEvents(appContext)
        }
    }

    private suspend fun processCommand(context: Context, command: JSONObject, source: String) {
        val commandId = cleanId(command.optString("command_id"))
        val requestId = cleanId(command.optString("request_id"))
        if (commandId.isBlank()) {
            DebugLog.log("设备命令", "忽略缺少 command_id 的命令")
            return
        }

        DeviceCommandStore.storedResult(context, commandId)?.let { saved ->
            DebugLog.log("设备命令", "重复命令，重发已保存结果: $commandId")
            sendOrQueue(context, buildReceipt(command, requestId, commandId), receiptEventKey(commandId))
            sendOrQueue(context, saved, resultEventKey(commandId, saved.optString("result_id")))
            return
        }
        if (!inFlightCommands.add(commandId)) {
            sendOrQueue(context, buildReceipt(command, requestId, commandId), receiptEventKey(commandId))
            return
        }

        try {
            val receipt = buildReceipt(command, requestId, commandId)
            sendOrQueue(context, receipt, receiptEventKey(commandId))

            val resultId = DeviceCommandStore.resultIdFor(context, commandId)
            val result = executeNormalCommand(context, command, resultId, source)
            DeviceCommandStore.storeResult(context, commandId, result)
            sendOrQueue(context, result, resultEventKey(commandId, resultId))
        } finally {
            inFlightCommands.remove(commandId)
        }
    }

    private fun buildReceipt(command: JSONObject, requestId: String, commandId: String): JSONObject =
        JSONObject()
            .put("type", "device_command_receipt")
            .put("v", 1)
            .put("request_id", requestId.ifBlank { cleanId(command.optString("request_id")) })
            .put("command_id", commandId.ifBlank { cleanId(command.optString("command_id")) })
            .put("status", "received")
            .put("received_at", Instant.now().toString())

    private fun executeNormalCommand(
        context: Context,
        command: JSONObject,
        resultId: String,
        source: String,
    ): JSONObject {
        val commandId = cleanId(command.optString("command_id"))
        val requestId = cleanId(command.optString("request_id"))
        val actions = JSONArray()
        val stateAfter = frozenState()

        val expiresAt = command.optString("expires_at")
        if (isExpired(expiresAt)) {
            return result(commandId, requestId, resultId, RESULT_EXPIRED, actions, stateAfter, "command_expired")
        }

        val payload = command.optJSONObject("payload")
        val kind = payload?.optString("kind").orEmpty()
        if (payload == null) {
            return result(commandId, requestId, resultId, RESULT_UNSUPPORTED, actions, stateAfter, "unsupported_command_kind")
        }
        if (kind == KIND_SUPERVISION_POLICY) {
            return result(commandId, requestId, resultId, RESULT_UNSUPPORTED, actions, stateAfter, "policy_requires_android_lsp")
        }
        if (kind != KIND_SUPERVISION) {
            return result(commandId, requestId, resultId, RESULT_UNSUPPORTED, actions, stateAfter, "unsupported_command_kind")
        }

        var applied = 0
        var unsupported = 0
        var failed = 0
        var ignored = 0

        val freezeCommands = payload.optJSONArray("freeze_commands")
        if (freezeCommands != null && freezeCommands.length() > 0) {
            actions.put(action("freeze", RESULT_UNSUPPORTED, "normal_app_no_freeze_capability", commands = freezeCommands))
            unsupported++
        }

        val unfreezeCommands = payload.optJSONArray("unfreeze_commands")
        if (unfreezeCommands != null && unfreezeCommands.length() > 0) {
            actions.put(action("unfreeze", RESULT_UNSUPPORTED, "normal_app_no_unfreeze_capability", commands = unfreezeCommands))
            unsupported++
        }

        if (payload.strictBoolean("screen_off", false)) {
            actions.put(action("screen_off", RESULT_UNSUPPORTED, "screen_off_not_supported"))
            unsupported++
        }

        val say = payload.optString("say").trim().take(500)
        if (say.isNotBlank()) {
            MessageSocketManager.notifyIncoming(
                context = context,
                text = say,
                viewerId = MessageInboxStore.SUPERVISOR_VIEWER_ID,
                messageId = commandId,
                viewerName = "MCP",
                kind = "private",
                payloadText = null,
            )
            actions.put(action("say", RESULT_APPLIED, source))
            applied++
        }

        if (payload.strictBoolean("vibrate", false)) {
            if (vibrate(context)) {
                actions.put(action("vibrate", RESULT_APPLIED, source))
                applied++
            } else {
                actions.put(action("vibrate", RESULT_FAILED, "vibrator_unavailable"))
                failed++
            }
        }

        if (applied == 0 && unsupported == 0 && failed == 0) {
            ignored++
            actions.put(action("noop", RESULT_IGNORED, "empty_or_no_matching_command"))
        }

        val status = when {
            applied > 0 && (unsupported > 0 || failed > 0 || ignored > 0) -> RESULT_PARTIAL
            applied > 0 -> RESULT_APPLIED
            failed > 0 -> RESULT_FAILED
            unsupported > 0 -> RESULT_UNSUPPORTED
            else -> RESULT_IGNORED
        }
        return result(commandId, requestId, resultId, status, actions, stateAfter, "")
    }

    private fun result(
        commandId: String,
        requestId: String,
        resultId: String,
        status: String,
        actions: JSONArray,
        stateAfter: JSONObject,
        reason: String,
    ): JSONObject {
        return JSONObject()
            .put("type", "device_command_result")
            .put("v", 1)
            .put("request_id", requestId)
            .put("command_id", commandId)
            .put("result_id", resultId)
            .put("status", status)
            .put("executed_at", Instant.now().toString())
            .put("actions", actions)
            .put("state_after", stateAfter)
            .apply {
                if (reason.isNotBlank()) put("reason", reason)
            }
    }

    private fun action(
        name: String,
        status: String,
        reason: String,
        commands: JSONArray? = null,
    ): JSONObject {
        return JSONObject()
            .put("action", name)
            .put("status", status)
            .put("reason", reason.take(240))
            .apply {
                if (commands != null) put("commands", commands)
            }
    }

    private fun frozenState(): JSONObject =
        JSONObject()
            .put("frozen_apps", JSONArray())
            .put("frozen_packages", JSONArray())

    @SuppressLint("MissingPermission")
    private fun vibrate(context: Context): Boolean {
        return runCatching {
            val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                context.getSystemService(VibratorManager::class.java)?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            } ?: return false
            if (!vibrator.hasVibrator()) return false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createOneShot(VIBRATION_MS, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(VIBRATION_MS)
            }
            true
        }.getOrDefault(false)
    }

    private fun sendOrQueue(context: Context, event: JSONObject, key: String) {
        if (key.isBlank()) return
        DeviceCommandStore.putPending(context, key, event)
        if (MessageSocketManager.sendDeviceCommandEvent(event)) {
            scheduleHttpFallback(context, key, event)
            return
        }
        scope.launch {
            postPendingEvent(context.applicationContext, key, event)
        }
    }

    private suspend fun flushPendingEvents(context: Context) {
        val pending = DeviceCommandStore.pendingEvents(context)
        for ((key, event) in pending) {
            if (MessageSocketManager.sendDeviceCommandEvent(event)) {
                scheduleHttpFallback(context, key, event)
                continue
            }
            postPendingEvent(context, key, event)
        }
    }

    private fun scheduleHttpFallback(context: Context, key: String, event: JSONObject) {
        scope.launch {
            delay(WS_EVENT_ACK_FALLBACK_MS)
            postPendingEvent(context.applicationContext, key, event)
        }
    }

    private suspend fun postPendingEvent(context: Context, key: String, event: JSONObject) {
        withContext(Dispatchers.IO) {
            if (!DeviceCommandStore.containsPending(context, key)) return@withContext
            val settings = SettingsStore(context)
            val url = settings.serverUrl.first()
            val token = settings.getToken()
            if (url.isBlank() || token.isNullOrBlank()) return@withContext
            val client = ReportClient(url, token)
            try {
                val sent = client.postDeviceCommandEvent(event).isSuccess
                if (sent) DeviceCommandStore.removePending(context, key)
            } finally {
                client.shutdown()
            }
        }
    }

    private fun isExpired(value: String): Boolean =
        runCatching { Instant.parse(value).isBefore(Instant.now()) }.getOrDefault(false)

    private fun cleanId(value: String): String =
        value.replace(Regex("[\\u0000-\\u001f\\u007f]"), "")
            .trim()
            .take(160)
            .takeIf { it.matches(Regex("[a-zA-Z0-9_.:-]{1,160}")) }
            .orEmpty()

    private fun receiptEventKey(commandId: String): String =
        cleanId(commandId).takeIf { it.isNotBlank() }?.let { "receipt:$it" }.orEmpty()

    private fun resultEventKey(commandId: String, resultId: String): String {
        val cleanCommandId = cleanId(commandId)
        val cleanResultId = cleanId(resultId)
        return if (cleanCommandId.isBlank() || cleanResultId.isBlank()) "" else "result:$cleanCommandId:$cleanResultId"
    }

    private fun parseObject(text: String?): JSONObject? =
        runCatching { JSONObject(text.orEmpty()) }.getOrNull()

    private fun JSONObject.strictBoolean(key: String, defaultWhenMissing: Boolean): Boolean {
        if (!has(key) || isNull(key)) return defaultWhenMissing
        return opt(key) as? Boolean ?: false
    }
}

private object DeviceCommandStore {
    private const val PREFS = "device_commands"
    private const val KEY_PENDING = "pending_events"
    private const val KEY_RESULTS = "results"
    private const val KEY_RESULT_IDS = "result_ids"
    private const val MAX_PENDING = 40
    private const val MAX_RESULTS = 80

    @Synchronized
    fun resultIdFor(context: Context, commandId: String): String {
        val cleanCommandId = commandId.trim()
        val prefs = prefs(context)
        val ids = JSONObject(prefs.getString(KEY_RESULT_IDS, "{}").orEmpty().ifBlank { "{}" })
        val existing = ids.optString(cleanCommandId)
        if (existing.isNotBlank()) return existing
        val created = "res_${UUID.randomUUID()}"
        ids.put(cleanCommandId, created)
        prefs.edit().putString(KEY_RESULT_IDS, trimObject(ids, MAX_RESULTS).toString()).apply()
        return created
    }

    @Synchronized
    fun storedResult(context: Context, commandId: String): JSONObject? {
        val results = JSONObject(prefs(context).getString(KEY_RESULTS, "{}").orEmpty().ifBlank { "{}" })
        val raw = results.optString(commandId)
        return runCatching { JSONObject(raw) }.getOrNull()
    }

    @Synchronized
    fun storeResult(context: Context, commandId: String, result: JSONObject) {
        val results = JSONObject(prefs(context).getString(KEY_RESULTS, "{}").orEmpty().ifBlank { "{}" })
        results.put(commandId, result.toString())
        prefs(context).edit().putString(KEY_RESULTS, trimObject(results, MAX_RESULTS).toString()).apply()
    }

    @Synchronized
    fun putPending(context: Context, key: String, event: JSONObject) {
        val pending = pendingObject(context)
        pending.put(key, event.toString())
        prefs(context).edit().putString(KEY_PENDING, trimObject(pending, MAX_PENDING).toString()).apply()
    }

    @Synchronized
    fun removePending(context: Context, key: String) {
        if (key.isBlank()) return
        val pending = pendingObject(context)
        pending.remove(key)
        prefs(context).edit().putString(KEY_PENDING, pending.toString()).apply()
    }

    @Synchronized
    fun containsPending(context: Context, key: String): Boolean {
        if (key.isBlank()) return false
        return pendingObject(context).has(key)
    }

    @Synchronized
    fun pendingEvents(context: Context): List<Pair<String, JSONObject>> {
        val pending = pendingObject(context)
        val out = mutableListOf<Pair<String, JSONObject>>()
        val keys = pending.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val event = runCatching { JSONObject(pending.optString(key)) }.getOrNull() ?: continue
            out += key to event
        }
        return out
    }

    private fun pendingObject(context: Context): JSONObject =
        JSONObject(prefs(context).getString(KEY_PENDING, "{}").orEmpty().ifBlank { "{}" })

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun trimObject(input: JSONObject, max: Int): JSONObject {
        val keys = mutableListOf<String>()
        val iterator = input.keys()
        while (iterator.hasNext()) keys += iterator.next()
        val keep = keys.takeLast(max).toSet()
        val out = JSONObject()
        for (key in keys) {
            if (key in keep) out.put(key, input.opt(key))
        }
        return out
    }
}
