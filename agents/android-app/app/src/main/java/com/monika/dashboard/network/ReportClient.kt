package com.monika.dashboard.network

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import android.content.Context
import android.util.Base64
import com.monika.dashboard.data.DebugLog
import com.monika.dashboard.data.UploadStatusStore
import com.monika.dashboard.data.VisitorMessage
import java.net.URLEncoder
import java.net.URI
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.TimeZone
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import com.monika.dashboard.system.LocationSnapshot
import com.monika.dashboard.system.DeviceEnvironment
import com.monika.dashboard.system.SystemSnapshot
import com.monika.dashboard.system.isSleeping

data class ReportAppRequest(
    val appId: String,
    val windowTitle: String,
    val telemetry: ReportTelemetry = ReportTelemetry(),
)

data class ReportTelemetry(
    val battery: ReportBattery? = null,
    val network: ReportNetwork? = null,
    val vpn: ReportVpn? = null,
    val location: LocationSnapshot? = null,
    val snapshot: SystemSnapshot? = null,
    val environment: DeviceEnvironment? = null,
    val music: ReportMusic? = null,
)

data class ReportBattery(
    val percent: Int,
    val charging: Boolean,
)

data class ReportNetwork(
    val connected: Boolean,
    val type: String? = null,
    val cellularGeneration: String? = null,
)

data class ReportVpn(
    val active: Boolean,
    val name: String? = null,
)

data class ReportMusic(
    val title: String,
    val artist: String? = null,
    val app: String? = null,
)

/**
 * HTTP client for reporting app activity and health data.
 * All methods perform synchronous IO — call from background threads only.
 */
class ReportClient(
    private val serverUrl: String,
    private val token: String,
    private val context: Context? = null,
) {
    init {
        val uri = URI(serverUrl)
        val scheme = uri.scheme ?: ""
        val host = uri.host ?: ""
        require(
            scheme == "https" ||
            (scheme == "http" && (host == "localhost" || host == "127.0.0.1"))
        ) { "Only HTTPS or http://localhost allowed" }
    }
        // Shared OkHttpClient — single connection pool for all operations
        private val client get() = sharedClient

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    fun reportApp(request: ReportAppRequest): Result<Unit> {
        val telemetry = request.telemetry
        val body = JSONObject().apply {
            put("app_id", request.appId)
            put("window_title", request.windowTitle)
            put("timestamp", Instant.now().toString())

            val extra = JSONObject()
            telemetry.battery?.let {
                extra.put("battery_percent", it.percent)
                extra.put("battery_charging", it.charging)
            }
            if (telemetry.snapshot?.isSleeping() == true) extra.put("sleeping", true)
            val device = JSONObject()
            telemetry.network?.let { network ->
                device.put("network_connected", network.connected)
                network.type?.takeIf { it.isNotBlank() }?.let { device.put("network_type", it.take(64)) }
                network.cellularGeneration?.takeIf { it.isNotBlank() }?.let {
                    device.put("cellular_generation", it.take(64))
                }
            }
            telemetry.vpn?.let { vpn ->
                device.put("vpn_active", vpn.active)
                vpn.name?.let { device.put("vpn_name", it.take(64)) }
            }
            putEnvironmentExtras(device, telemetry.environment)
            telemetry.snapshot?.let {
                device.put("capability_mode", it.capabilityMode)
                device.put("last_sample_at", Instant.ofEpochMilli(it.sampledAt).toString())
                device.put(
                    "energy_policy",
                    if (it.capabilityMode == "root") "app_workmanager_root" else "app_workmanager"
                )
            }
            if (device.length() > 0) extra.put("device", device)

            telemetry.location?.let { loc ->
                extra.put("location", JSONObject().apply {
                    put("latitude", loc.latitude)
                    put("longitude", loc.longitude)
                    loc.accuracyMeters?.let { put("accuracy_m", it.toDouble()) }
                    loc.provider?.let { put("provider", it.take(64)) }
                    put("recorded_at", Instant.ofEpochMilli(loc.recordedAt).toString())
                })
            }

            telemetry.snapshot?.foreground?.let { fg ->
                val foreground = JSONObject()
                fg.packageName?.let { foreground.put("package_name", it.take(64)) }
                fg.appName?.let { foreground.put("app_name", it.take(64)) }
                fg.activity?.let { foreground.put("activity", it.take(256)) }
                fg.title?.let { foreground.put("title", it.take(256)) }
                foreground.put("source", fg.source)
                foreground.put("confidence", fg.confidence.coerceIn(0.0, 1.0))
                if (foreground.length() > 0) extra.put("foreground", foreground)
            }

            telemetry.snapshot?.media?.let { mediaInfo ->
                val media = JSONObject()
                mediaInfo.playing?.let { media.put("playing", it) }
                mediaInfo.title?.let { media.put("title", it.take(256)) }
                mediaInfo.artist?.let { media.put("artist", it.take(256)) }
                mediaInfo.app?.let { media.put("app", it.take(64)) }
                mediaInfo.packageName?.let { media.put("package_name", it.take(64)) }
                mediaInfo.state?.let { media.put("state", it.take(64)) }
                media.put("source", mediaInfo.source)
                if (media.length() > 0) extra.put("media", media)
            }

            telemetry.music?.let { reportMusic ->
                val music = JSONObject()
                music.put("title", reportMusic.title.take(256))
                reportMusic.artist?.let { music.put("artist", it.take(256)) }
                reportMusic.app?.let { music.put("app", it.take(64)) }
                extra.put("music", music)
            }

            if (extra.length() > 0) {
                put("extra", extra)
            }
        }

        context?.let { UploadStatusStore.setLastPayload(it, body.toString(2)) }
        return post("${serverUrl.trimEnd('/')}/api/report", body)
    }

    fun postReportBody(body: String): Result<Unit> {
        context?.let { UploadStatusStore.setLastPayload(it, body.take(12_000)) }
        return postRaw("${serverUrl.trimEnd('/')}/api/report", body)
    }

    fun reportHealthData(records: List<HealthRecord>): Result<Unit> {
        val body = JSONObject().apply {
            val arr = JSONArray()
            for (record in records) {
                arr.put(JSONObject().apply {
                    put("type", record.type)
                    put("value", record.value)
                    put("unit", record.unit)
                    put("timestamp", record.timestamp)
                    if (record.endTime != null) {
                        put("end_time", record.endTime)
                    }
                })
            }
            put("records", arr)
        }

        context?.let { UploadStatusStore.setLastPayload(it, body.toString(2)) }
        return post("${serverUrl.trimEnd('/')}/api/health-data", body)
    }

    fun testConnection(): Result<Unit> {
        val request = Request.Builder()
            .url("${serverUrl.trimEnd('/')}/api/health")
            .addHeader("Authorization", "Bearer $token")
            .get()
            .build()

        return try {
            val response = client.newCall(request).execute()
            response.use {
                if (it.isSuccessful) Result.success(Unit)
                else Result.failure(IOException("HTTP ${it.code}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun fetchMessages(): Result<List<DeviceMessage>> {
        val request = Request.Builder()
            .url("${serverUrl.trimEnd('/')}/api/messages")
            .addHeader("Authorization", "Bearer $token")
            .get()
            .build()

        return try {
            val response = client.newCall(request).execute()
            response.use {
                if (!it.isSuccessful) return Result.failure(IOException("HTTP ${it.code}"))
                val body = it.body?.string().orEmpty()
                val arr = JSONObject(body).optJSONArray("messages") ?: JSONArray()
                val messages = buildList {
                    for (i in 0 until arr.length()) {
                        val item = arr.optJSONObject(i) ?: continue
                        add(
                            DeviceMessage(
                                id = item.optString("id"),
                                viewerId = item.optString("viewer_id"),
                                viewerName = item.optString("viewer_name"),
                                kind = item.optString("kind", "private"),
                                text = item.optString("text"),
                                payload = item.optJSONObject("payload")?.toString(),
                            )
                        )
                    }
                }
                Result.success(messages)
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun fetchMessageHistory(since: String? = null): Result<List<VisitorMessage>> {
        val suffix = if (!since.isNullOrBlank()) {
            "?since=${java.net.URLEncoder.encode(since, "UTF-8")}"
        } else {
            ""
        }
        val request = Request.Builder()
            .url("${serverUrl.trimEnd('/')}/api/messages/history$suffix")
            .addHeader("Authorization", "Bearer $token")
            .get()
            .build()

        return try {
            val response = client.newCall(request).execute()
            response.use {
                if (!it.isSuccessful) return Result.failure(IOException("HTTP ${it.code}"))
                val body = it.body?.string().orEmpty()
                val arr = JSONObject(body).optJSONArray("messages") ?: JSONArray()
                val messages = buildList {
                    for (i in 0 until arr.length()) {
                        val item = arr.optJSONObject(i) ?: continue
                        val createdAt = item.optString("created_at")
                        val at = runCatching { Instant.parse(createdAt).toEpochMilli() }
                            .getOrDefault(System.currentTimeMillis())
                        add(
                            VisitorMessage(
                                id = item.optString("id"),
                                viewerId = item.optString("viewer_id"),
                                viewerName = item.optString("viewer_name"),
                                viewerRemark = item.optString("viewer_remark"),
                                kind = item.optString("kind", "private"),
                                direction = item.optString("direction", "viewer"),
                                text = item.optString("text"),
                                at = at,
                            )
                        )
                    }
                }
                Result.success(messages)
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun replyToMessage(messageId: String, viewerId: String, text: String): Result<Unit> {
        val body = JSONObject().apply {
            put("message_id", messageId)
            put("reply_id", java.util.UUID.randomUUID().toString())
            put("target_viewer_id", viewerId)
            put("text", text.take(500))
        }
        return post("${serverUrl.trimEnd('/')}/api/messages/reply", body)
    }

    fun blockViewer(viewerId: String): Result<Unit> {
        val body = JSONObject().apply {
            put("viewer_id", viewerId.take(120))
        }
        return post("${serverUrl.trimEnd('/')}/api/messages/block", body)
    }

    fun unblockViewer(viewerId: String): Result<Unit> {
        val body = JSONObject().apply {
            put("viewer_id", viewerId.take(120))
        }
        return post("${serverUrl.trimEnd('/')}/api/messages/unblock", body)
    }

    fun deleteMessage(messageId: String): Result<Unit> {
        val body = JSONObject().apply {
            put("message_id", messageId.take(120))
        }
        return post("${serverUrl.trimEnd('/')}/api/messages/delete", body)
    }

    fun deleteViewerMessages(viewerId: String): Result<Unit> {
        val body = JSONObject().apply {
            put("viewer_id", viewerId.take(120))
        }
        return post("${serverUrl.trimEnd('/')}/api/messages/viewer/delete", body)
    }

    fun setViewerRemark(viewerId: String, remark: String): Result<Unit> {
        val body = JSONObject().apply {
            put("viewer_id", viewerId.take(120))
            put("remark", remark.take(500))
        }
        return post("${serverUrl.trimEnd('/')}/api/messages/remark", body)
    }

    data class PublicMessage(
        val id: String,
        val viewerId: String,
        val viewerName: String,
        val kind: String,
        val text: String,
        val createdAt: String,
    )

    fun fetchPublicMessages(recentHours: Int = PUBLIC_RECENT_HOURS, slot: String? = null): Result<List<PublicMessage>> {
        return try {
            val base = "${serverUrl.trimEnd('/')}/api/messages/public"
            val url = if (slot != null && slot.matches(Regex("^\\d{12}$"))) {
                "$base?slot=${URLEncoder.encode(slot, "UTF-8")}"
            } else {
                "$base?recent=1&hours=${recentHours.coerceIn(1, PUBLIC_RECENT_HOURS)}"
            }
            val request = Request.Builder().url(url).addHeader("Authorization", "Bearer $token").get().build()
            val response = client.newCall(request).execute()
            response.use {
                if (!it.isSuccessful) return Result.failure(IOException("HTTP ${it.code}"))
                val body = it.body?.string() ?: return Result.success(emptyList())
                val arr = JSONObject(body).optJSONArray("messages") ?: return Result.success(emptyList())
                val list = mutableListOf<PublicMessage>()
                for (i in 0 until arr.length()) {
                    val m = arr.getJSONObject(i)
                    list.add(PublicMessage(
                        id = m.optString("id"),
                        viewerId = m.optString("viewer_id"),
                        viewerName = m.optString("viewer_name"),
                        kind = m.optString("kind", "public"),
                        text = m.optString("text"),
                        createdAt = m.optString("created_at"),
                    ))
                }
                Result.success(list)
            }
        } catch (e: Exception) { Result.failure(e) }
    }

    data class DailySummary(
        val date: String,
        val summary: String?,
        val generatedAt: String?,
        val mode: String?,
    )

    data class WeeklySummary(
        val weekStart: String,
        val weekEnd: String,
        val summary: String?,
        val generatedAt: String?,
        val mode: String?,
    )

    data class SummarySettings(
        val mode: String,
        val target: String,
        val plannedRest: Boolean,
        val weeklyPlan: List<SummaryPlanDay>,
        val dailySummaryTime: String,
        val weeklySummaryWeekday: Int,
        val weeklySummaryTime: String,
        val supervisionEnabled: Boolean,
        val supervisionCheckMode: String,
        val supervisionCheckIntervalMinutes: Int,
        val supervisionBlacklistMinutes: Int,
        val supervisionTargetMinMinutes: Int,
        val supervisionVibrate: Boolean,
        val supervisionSkipWatchSleep: Boolean,
        val supervisionLspFreeze: Boolean,
        val supervisionRules: SupervisionRules,
        val supervisionRulesUpdatedAt: String?,
        val supervisionRulesError: String?,
        val updatedAt: String?,
        val syncStatus: String?,
    )

    data class SummarySettingsUpdate(
        val mode: String,
        val target: String,
        val plannedRest: Boolean,
        val weeklyPlan: List<SummaryPlanDay>,
        val dailySummaryTime: String,
        val weeklySummaryWeekday: Int,
        val weeklySummaryTime: String,
        val supervisionEnabled: Boolean,
        val supervisionCheckMode: String,
        val supervisionCheckIntervalMinutes: Int,
        val supervisionBlacklistMinutes: Int,
        val supervisionTargetMinMinutes: Int,
        val supervisionVibrate: Boolean,
        val supervisionSkipWatchSleep: Boolean,
        val supervisionLspFreeze: Boolean,
        val clientUpdatedAt: String?,
    )

    data class SummaryPlanDay(
        val weekday: Int,
        val target: String,
        val plannedRest: Boolean,
    )

    data class AiConfig(
        val configured: Boolean,
        val locked: Boolean,
        val source: String,
        val apiUrl: String?,
        val apiUrlHint: String?,
        val model: String,
        val updatedAt: String?,
        val message: String?,
        val encryptionAlg: String?,
        val encryptionPublicKey: String?,
        val encryptionPublicKeySha256: String?,
    )

    data class AiConfigTestResult(
        val ok: Boolean,
        val message: String,
        val models: List<String>,
        val selectedModel: String,
        val modelAvailable: Boolean?,
        val modelsUrl: String,
        val chatChecked: Boolean,
        val modelsError: String?,
    )

    data class TimelineSegment(
        val appName: String,
        val appId: String,
        val displayTitle: String,
        val startedAt: String,
        val endedAt: String?,
        val durationSeconds: Int,
        val durationMinutes: Int,
        val deviceId: String,
        val deviceName: String,
    )

    data class TimelineResponse(
        val date: String,
        val segments: List<TimelineSegment>,
        val summary: Map<String, Map<String, Double>>,
    )

    fun fetchDailySummary(date: String): Result<DailySummary> {
        return try {
            val request = Request.Builder()
                .url("${serverUrl.trimEnd('/')}/api/daily-summary?date=${URLEncoder.encode(date, "UTF-8")}")
                .addHeader("Authorization", "Bearer $token")
                .get()
                .build()
            val response = client.newCall(request).execute()
            response.use {
                if (!it.isSuccessful) return Result.failure(IOException("HTTP ${it.code}"))
                val body = it.body?.string().orEmpty()
                val json = JSONObject(body)
                Result.success(
                    DailySummary(
                        date = json.optString("date", date),
                        summary = json.optString("summary").takeIf { value -> value.isNotBlank() && value != "null" },
                        generatedAt = json.optString("generated_at").takeIf { value -> value.isNotBlank() && value != "null" },
                        mode = json.optString("mode").takeIf { value -> value.isNotBlank() && value != "null" },
                    ),
                )
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun fetchWeeklySummary(date: String): Result<WeeklySummary> {
        return try {
            val request = Request.Builder()
                .url("${serverUrl.trimEnd('/')}/api/weekly-summary?date=${URLEncoder.encode(date, "UTF-8")}")
                .addHeader("Authorization", "Bearer $token")
                .get()
                .build()
            executeSummaryRequest(request, date)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun refreshDailySummary(date: String): Result<DailySummary> {
        val body = JSONObject().apply {
            put("date", date)
            put("tz", clientTimezoneOffsetMinutes())
        }
        val request = Request.Builder()
            .url("${serverUrl.trimEnd('/')}/api/daily-summary")
            .addHeader("Authorization", "Bearer $token")
            .addHeader("Content-Type", "application/json")
            .post(body.toString().toRequestBody(jsonMediaType))
            .build()

        return try {
            val response = client.newCall(request).execute()
            response.use {
                if (!it.isSuccessful) return Result.failure(IOException("HTTP ${it.code}: ${errorText(it.body?.string())}"))
                val json = JSONObject(it.body?.string().orEmpty())
                Result.success(
                    DailySummary(
                        date = json.optString("date", date),
                        summary = json.optString("summary").takeIf { value -> value.isNotBlank() && value != "null" },
                        generatedAt = json.optString("generated_at").takeIf { value -> value.isNotBlank() && value != "null" },
                        mode = json.optString("mode").takeIf { value -> value.isNotBlank() && value != "null" },
                    ),
                )
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun refreshWeeklySummary(date: String): Result<WeeklySummary> {
        val body = JSONObject().apply {
            put("date", date)
            put("tz", clientTimezoneOffsetMinutes())
        }
        val request = Request.Builder()
            .url("${serverUrl.trimEnd('/')}/api/weekly-summary")
            .addHeader("Authorization", "Bearer $token")
            .addHeader("Content-Type", "application/json")
            .post(body.toString().toRequestBody(jsonMediaType))
            .build()

        return try {
            executeSummaryRequest(request, date)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun fetchSummarySettings(): Result<SummarySettings> {
        val request = Request.Builder()
            .url("${serverUrl.trimEnd('/')}/api/summary-settings")
            .addHeader("Authorization", "Bearer $token")
            .get()
            .build()
        return executeSettingsRequest(request)
    }

    fun updateSummarySettings(update: SummarySettingsUpdate): Result<SummarySettings> {
        val body = JSONObject().apply {
            put("mode", update.mode)
            put("target", update.target.take(240))
            put("planned_rest", update.plannedRest)
            put("weekly_plan", JSONArray().apply {
                update.weeklyPlan.forEach { item ->
                    put(JSONObject().apply {
                        put("weekday", item.weekday.coerceIn(1, 7))
                        put("target", item.target.take(240))
                        put("planned_rest", false)
                    })
                }
            })
            put("daily_summary_time", update.dailySummaryTime)
            put("weekly_summary_weekday", update.weeklySummaryWeekday.coerceIn(1, 7))
            put("weekly_summary_time", update.weeklySummaryTime)
            put("supervision_enabled", update.supervisionEnabled)
            put("supervision_check_mode", update.supervisionCheckMode)
            put("supervision_check_interval_minutes", update.supervisionCheckIntervalMinutes.coerceIn(30, 240))
            put("supervision_blacklist_minutes", update.supervisionBlacklistMinutes.coerceIn(1, 55))
            put("supervision_target_min_minutes", update.supervisionTargetMinMinutes.coerceIn(1, 55))
            put("supervision_vibrate", update.supervisionVibrate)
            put("supervision_skip_watch_sleep", update.supervisionSkipWatchSleep)
            put("supervision_lsp_freeze", update.supervisionLspFreeze)
            if (!update.clientUpdatedAt.isNullOrBlank()) {
                put("client_updated_at", update.clientUpdatedAt)
            }
        }
        val request = Request.Builder()
            .url("${serverUrl.trimEnd('/')}/api/summary-settings")
            .addHeader("Authorization", "Bearer $token")
            .addHeader("Content-Type", "application/json")
            .post(body.toString().toRequestBody(jsonMediaType))
            .build()
        return executeSettingsRequest(request)
    }

    fun fetchAiConfig(): Result<AiConfig> {
        DebugLog.log("AI", "读取配置: ${serverUrl.trimEnd('/')}/api/ai-config")
        val request = Request.Builder()
            .url("${serverUrl.trimEnd('/')}/api/ai-config")
            .addHeader("Authorization", "Bearer $token")
            .get()
            .build()
        return executeAiConfigRequest(request)
    }

    fun updateAiConfig(apiUrl: String, apiKey: String, model: String): Result<AiConfig> {
        DebugLog.log("AI", "保存配置: endpoint=${safeAiEndpointForLog(apiUrl)} model=${model.ifBlank { "默认" }} key=${if (apiKey.isBlank()) "复用服务器已保存密钥" else "使用新密钥"}")
        return try {
            val body = encryptedAiConfigBodyFromServer(apiUrl, apiKey, model).getOrElse {
                return Result.failure(it)
            }
            val request = Request.Builder()
                .url("${serverUrl.trimEnd('/')}/api/ai-config")
                .addHeader("Authorization", "Bearer $token")
                .addHeader("Content-Type", "application/json")
                .post(body.toString().toRequestBody(jsonMediaType))
                .build()
            executeAiConfigRequest(request)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun testAiConfig(apiUrl: String, apiKey: String, model: String): Result<AiConfigTestResult> {
        DebugLog.log("AI", "测试连接: endpoint=${safeAiEndpointForLog(apiUrl)} model=${model.ifBlank { "默认" }} key=${if (apiKey.isBlank()) "复用服务器已保存密钥" else "使用输入密钥"}")
        return try {
            val body = encryptedAiConfigBodyFromServer(apiUrl, apiKey, model).getOrElse {
                return Result.failure(it)
            }
            val request = Request.Builder()
                .url("${serverUrl.trimEnd('/')}/api/ai-config/test")
                .addHeader("Authorization", "Bearer $token")
                .addHeader("Content-Type", "application/json")
                .post(body.toString().toRequestBody(jsonMediaType))
                .build()
            executeAiConfigTestRequest(request)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun fetchTimeline(date: String): Result<TimelineResponse> {
        return try {
            val tz = clientTimezoneOffsetMinutes()
            val url = "${serverUrl.trimEnd('/')}/api/timeline?date=${URLEncoder.encode(date, "UTF-8")}&tz=$tz"
            val request = Request.Builder()
                .url(url)
                .addHeader("Authorization", "Bearer $token")
                .get()
                .build()
            val response = client.newCall(request).execute()
            response.use {
                if (!it.isSuccessful) return Result.failure(IOException("HTTP ${it.code}"))
                val body = it.body?.string().orEmpty()
                val json = JSONObject(body)
                val arr = json.optJSONArray("segments") ?: JSONArray()
                val segments = buildList {
                    for (i in 0 until arr.length()) {
                        val item = arr.optJSONObject(i) ?: continue
                        add(
                            TimelineSegment(
                                appName = item.optString("app_name"),
                                appId = item.optString("app_id"),
                                displayTitle = item.optString("display_title"),
                                startedAt = item.optString("started_at"),
                                endedAt = item.optString("ended_at").takeIf { value -> value.isNotBlank() && value != "null" },
                                durationSeconds = item.optInt("duration_seconds", 0).coerceAtLeast(0),
                                durationMinutes = item.optInt("duration_minutes", 0).coerceAtLeast(0),
                                deviceId = item.optString("device_id"),
                                deviceName = item.optString("device_name"),
                            ),
                        )
                    }
                }
                Result.success(
                    TimelineResponse(
                        date = json.optString("date", date),
                        segments = segments,
                        summary = parseTimelineSummary(json.optJSONObject("summary")),
                    ),
                )
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    private fun post(url: String, body: JSONObject): Result<Unit> =
        postRaw(url, body.toString())

    private fun postRaw(url: String, body: String): Result<Unit> {
        val request = Request.Builder()
            .url(url)
            .addHeader("Authorization", "Bearer $token")
            .addHeader("Content-Type", "application/json")
            .post(body.toRequestBody(jsonMediaType))
            .build()

        return try {
            val response = client.newCall(request).execute()
            response.use {
                if (it.isSuccessful || it.code == 409) Result.success(Unit)
                else Result.failure(IOException("HTTP ${it.code}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    // shutdown is a no-op — the shared client lives for the process lifetime
    fun shutdown() {}

    companion object {
        @Volatile
        private var _shared: OkHttpClient? = null

        val sharedClient: OkHttpClient
            get() {
                _shared?.let { return it }
                synchronized(this) {
                    _shared?.let { return it }
                    _shared = OkHttpClient.Builder()
                        .connectTimeout(10, TimeUnit.SECONDS)
                        .writeTimeout(10, TimeUnit.SECONDS)
                        .readTimeout(10, TimeUnit.SECONDS)
                        .build()
                    return _shared!!
                }
            }

        const val PUBLIC_RECENT_HOURS = 168
        private const val CURVE25519_KEY_SIZE = 32
        private const val AES_256_KEY_SIZE = 32
        private const val AES_GCM_NONCE_SIZE = 12
        private const val AI_CONFIG_ENCRYPTION_ALG = "X25519-A256GCM-HS256"
    }

    private fun executeSummaryRequest(request: Request, fallbackDate: String): Result<WeeklySummary> {
        val response = client.newCall(request).execute()
        response.use {
            if (!it.isSuccessful) return Result.failure(IOException("HTTP ${it.code}: ${errorText(it.body?.string())}"))
            val json = JSONObject(it.body?.string().orEmpty())
            return Result.success(
                WeeklySummary(
                    weekStart = json.optString("week_start", fallbackDate),
                    weekEnd = json.optString("week_end", fallbackDate),
                    summary = json.optString("summary").takeIf { value -> value.isNotBlank() && value != "null" },
                    generatedAt = json.optString("generated_at").takeIf { value -> value.isNotBlank() && value != "null" },
                    mode = json.optString("mode").takeIf { value -> value.isNotBlank() && value != "null" },
                ),
            )
        }
    }

    private fun executeSettingsRequest(request: Request): Result<SummarySettings> {
        return try {
            val response = client.newCall(request).execute()
            response.use {
                if (!it.isSuccessful) return Result.failure(IOException("HTTP ${it.code}: ${errorText(it.body?.string())}"))
                val json = JSONObject(it.body?.string().orEmpty())
                Result.success(
                    SummarySettings(
                        mode = json.optString("mode", "normal"),
                        target = json.optString("target", ""),
                        plannedRest = json.optBoolean("planned_rest", false),
                        weeklyPlan = parseSummaryPlan(json.optJSONArray("weekly_plan")),
                        dailySummaryTime = json.optString("daily_summary_time", "21:00"),
                        weeklySummaryWeekday = json.optInt("weekly_summary_weekday", 7).coerceIn(1, 7),
                        weeklySummaryTime = json.optString("weekly_summary_time", "21:30"),
                        supervisionEnabled = json.optBoolean("supervision_enabled", false),
                        supervisionCheckMode = json.optString("supervision_check_mode", "hourly"),
                        supervisionCheckIntervalMinutes = json.optInt("supervision_check_interval_minutes", 60).coerceIn(30, 240),
                        supervisionBlacklistMinutes = json.optInt("supervision_blacklist_minutes", 20).coerceIn(1, 55),
                        supervisionTargetMinMinutes = json.optInt("supervision_target_min_minutes", 25).coerceIn(1, 55),
                        supervisionVibrate = json.optBoolean("supervision_vibrate", true),
                        supervisionSkipWatchSleep = json.optBoolean("supervision_skip_watch_sleep", true),
                        supervisionLspFreeze = json.optBoolean("supervision_lsp_freeze", false),
                        supervisionRules = parseSupervisionRules(json.optJSONObject("supervision_rules")),
                        supervisionRulesUpdatedAt = json.optString("supervision_rules_updated_at").takeIf { value -> value.isNotBlank() && value != "null" },
                        supervisionRulesError = json.optString("supervision_rules_error").takeIf { value -> value.isNotBlank() && value != "null" },
                        updatedAt = json.optString("updated_at").takeIf { value -> value.isNotBlank() && value != "null" },
                        syncStatus = json.optString("sync_status").takeIf { value -> value.isNotBlank() && value != "null" },
                    ),
                )
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    private fun executeAiConfigRequest(request: Request): Result<AiConfig> {
        return try {
            val response = client.newCall(request).execute()
            response.use {
                val raw = it.body?.string().orEmpty()
                DebugLog.log("AI", "配置响应 HTTP ${it.code}: ${sanitizeLogText(raw).take(1200)}")
                if (!it.isSuccessful) return Result.failure(IOException("HTTP ${it.code}: ${errorText(raw)}"))
                val json = JSONObject(raw)
                Result.success(parseAiConfig(json))
            }
        } catch (e: Exception) {
            DebugLog.log("AI", "配置请求异常: ${sanitizeLogText(e.message.orEmpty()).take(800)}")
            Result.failure(e)
        }
    }

    private fun parseAiConfig(json: JSONObject): AiConfig {
        val encryption = json.optJSONObject("encryption")
        return AiConfig(
            configured = json.optBoolean("configured", false),
            locked = json.optBoolean("locked", false),
            source = json.optString("source", "none"),
            apiUrl = json.optString("api_url").takeIf { value -> value.isNotBlank() && value != "null" },
            apiUrlHint = json.optString("api_url_hint").takeIf { value -> value.isNotBlank() && value != "null" },
            model = json.optString("model", "gpt-4o-mini"),
            updatedAt = json.optString("updated_at").takeIf { value -> value.isNotBlank() && value != "null" },
            message = json.optString("message").takeIf { value -> value.isNotBlank() && value != "null" },
            encryptionAlg = encryption?.optString("alg")?.takeIf { value -> value.isNotBlank() },
            encryptionPublicKey = encryption?.optString("public_key")?.takeIf { value -> value.isNotBlank() },
            encryptionPublicKeySha256 = encryption?.optString("public_key_sha256")?.takeIf { value -> value.isNotBlank() },
        )
    }

    private fun encryptedAiConfigBodyFromServer(apiUrl: String, apiKey: String, model: String): Result<JSONObject> {
        return try {
            val current = fetchAiConfig().getOrThrow()
            DebugLog.log(
                "AI",
                "加密参数: serverKey=${current.encryptionPublicKeySha256?.take(12) ?: "missing"} locked=${current.locked} configured=${current.configured}"
            )
            if (current.locked) {
                return Result.failure(IOException("AI_CONFIG_LOCKED: ${current.message ?: "服务器环境变量已配置"}"))
            }
            val serverPublicKey = current.encryptionPublicKey
                ?: return Result.failure(IOException("AI_CONFIG_PUBLIC_KEY_MISSING"))
            if (current.encryptionAlg != AI_CONFIG_ENCRYPTION_ALG) {
                return Result.failure(IOException("AI_CONFIG_ALG_UNSUPPORTED"))
            }
            current.encryptionPublicKeySha256?.let { expected ->
                val actual = sha256Base64Url(base64UrlDecode(serverPublicKey))
                if (actual != expected) return Result.failure(IOException("AI_CONFIG_PUBLIC_KEY_HASH_MISMATCH"))
            }
            Result.success(encryptedAiConfigBody(apiUrl, apiKey, model, serverPublicKey))
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    private fun executeAiConfigTestRequest(request: Request): Result<AiConfigTestResult> {
        return try {
            val response = client.newCall(request).execute()
            response.use {
                val raw = it.body?.string().orEmpty()
                DebugLog.log("AI", "测试响应 HTTP ${it.code}: ${sanitizeLogText(raw).take(1200)}")
                if (!it.isSuccessful) return Result.failure(IOException("HTTP ${it.code}: ${errorText(raw)}"))
                val json = JSONObject(raw)
                val parsed = parseAiConfigTest(json)
                DebugLog.log(
                    "AI",
                    "测试结果: ok=${parsed.ok} selected=${parsed.selectedModel.ifBlank { "none" }} models=${parsed.models.size} message=${sanitizeLogText(parsed.message).take(800)}"
                )
                Result.success(parsed)
            }
        } catch (e: Exception) {
            DebugLog.log("AI", "测试异常: ${sanitizeLogText(e.message.orEmpty()).take(800)}")
            Result.failure(e)
        }
    }

    private fun parseAiConfigTest(json: JSONObject): AiConfigTestResult {
        val arr = json.optJSONArray("models") ?: JSONArray()
        val models = buildList {
            for (i in 0 until arr.length()) {
                arr.optString(i).takeIf { value -> value.isNotBlank() }?.let(::add)
            }
        }
        return AiConfigTestResult(
            ok = json.optBoolean("ok", false),
            message = json.optString("message").ifBlank { if (json.optBoolean("ok", false)) "AI 连接测试通过" else "AI 连接测试失败" },
            models = models,
            selectedModel = json.optString("selected_model", ""),
            modelAvailable = if (json.has("model_available") && !json.isNull("model_available")) json.optBoolean("model_available") else null,
            modelsUrl = json.optString("models_url", ""),
            chatChecked = json.optBoolean("chat_checked", false),
            modelsError = json.optString("models_error").takeIf { value -> value.isNotBlank() && value != "null" },
        )
    }

    private fun encryptedAiConfigBody(apiUrl: String, apiKey: String, model: String, serverPublicKey: String): JSONObject {
        val random = SecureRandom()
        val serverPublicKeyBytes = base64UrlDecode(serverPublicKey)
        require(serverPublicKeyBytes.size == CURVE25519_KEY_SIZE) { "Invalid server public key" }

        val privateKey = X25519PrivateKeyParameters(random)
        val publicKeyBytes = ByteArray(CURVE25519_KEY_SIZE)
        privateKey.generatePublicKey().encode(publicKeyBytes, 0)

        val shared = ByteArray(CURVE25519_KEY_SIZE)
        privateKey.generateSecret(X25519PublicKeyParameters(serverPublicKeyBytes, 0), shared, 0)

        val nonce = ByteArray(AES_GCM_NONCE_SIZE)
        random.nextBytes(nonce)
        val ts = System.currentTimeMillis() / 1000L
        val ephemeralPublicKey = base64UrlEncode(publicKeyBytes)
        val nonceText = base64UrlEncode(nonce)
        val signedMetadata = "2.$ts.$serverPublicKey.$ephemeralPublicKey.$nonceText"
        val aesKey = hkdfSha256(
            ikm = shared,
            salt = nonce,
            info = "live-dashboard-ai-config-x25519-v2.$serverPublicKey.$ephemeralPublicKey".toByteArray(StandardCharsets.UTF_8),
            length = AES_256_KEY_SIZE,
        )
        val plaintext = JSONObject().apply {
            put("api_url", apiUrl.trim())
            put("api_key", apiKey.trim())
            put("model", model.trim().ifBlank { "gpt-4o-mini" })
        }.toString().toByteArray(StandardCharsets.UTF_8)

        val ciphertext = try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(aesKey, "AES"), GCMParameterSpec(128, nonce))
            cipher.updateAAD(signedMetadata.toByteArray(StandardCharsets.UTF_8))
            cipher.doFinal(plaintext)
        } finally {
            plaintext.fill(0)
            shared.fill(0)
            aesKey.fill(0)
        }
        val ciphertextText = base64UrlEncode(ciphertext)
        val signed = "$signedMetadata.$ciphertextText"
        val signature = hmacBase64Url(token.toByteArray(StandardCharsets.UTF_8), signed.toByteArray(StandardCharsets.UTF_8))

        return JSONObject().apply {
            put("v", 2)
            put("alg", AI_CONFIG_ENCRYPTION_ALG)
            put("ts", ts)
            put("server_public_key", serverPublicKey)
            put("ephemeral_public_key", ephemeralPublicKey)
            put("nonce", nonceText)
            put("ciphertext", ciphertextText)
            put("signature", signature)
        }
    }

    private fun errorText(raw: String?): String =
        runCatching {
            val json = JSONObject(raw.orEmpty())
            val code = json.optString("code")
            val error = json.optString("error")
            listOf(code, error).filter { it.isNotBlank() }.joinToString(": ")
        }.getOrDefault(raw.orEmpty()).let(::sanitizeLogText).take(1000).ifBlank { "request failed" }

    private fun safeAiEndpointForLog(value: String): String =
        sanitizeLogText(value.trim()).take(300).ifBlank { "未填写" }

    private fun sanitizeLogText(value: String): String {
        var text = value
        if (token.isNotBlank()) text = text.replace(token, "[device-token]")
        text = text.replace(Regex("sk-[A-Za-z0-9_-]{8,}"), "sk-[redacted]")
        text = Regex("(?i)(Bearer\\s+)[A-Za-z0-9._~+/-]+=*").replace(text) {
            "${it.groupValues[1]}[redacted]"
        }
        return text.replace(Regex("\\s+"), " ").trim()
    }

    data class HealthRecord(
        val type: String,
        val value: Double,
        val unit: String,
        val timestamp: String,
        val endTime: String? = null
    )

    data class DeviceMessage(
        val id: String,
        val viewerId: String,
        val viewerName: String = "",
        val kind: String = "private",
        val text: String,
        val payload: String? = null,
    )
}

private fun putEnvironmentExtras(device: JSONObject, environment: DeviceEnvironment?) {
    val audio = environment?.audioOutput
    if (audio != null) {
        device.put("audio_output_connected", audio.connected)
        if (audio.type.isNotBlank()) device.put("audio_output_type", audio.type.take(64))
        if (audio.name.isNotBlank()) device.put("audio_output_name", audio.name.take(64))
    }
    val lux = environment?.ambientLux
    if (lux != null && lux.isFinite()) {
        device.put("ambient_lux", (lux.coerceIn(0f, 200_000f) * 10f).toInt() / 10.0)
    }
}

private fun base64UrlEncode(bytes: ByteArray): String =
    Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

private fun base64UrlDecode(value: String): ByteArray =
    Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

private fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key, "HmacSHA256"))
    return mac.doFinal(data)
}

private fun hmacBase64Url(key: ByteArray, data: ByteArray): String =
    base64UrlEncode(hmacSha256(key, data))

private fun sha256Base64Url(bytes: ByteArray): String =
    base64UrlEncode(MessageDigest.getInstance("SHA-256").digest(bytes))

private fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
    val prk = hmacSha256(salt, ikm)
    val out = ByteArray(length)
    var previous = ByteArray(0)
    var generated = 0
    var counter = 1
    while (generated < length) {
        val blockInput = ByteArray(previous.size + info.size + 1)
        previous.copyInto(blockInput)
        info.copyInto(blockInput, destinationOffset = previous.size)
        blockInput[blockInput.lastIndex] = counter.toByte()
        previous = hmacSha256(prk, blockInput)
        val toCopy = minOf(previous.size, length - generated)
        previous.copyInto(out, destinationOffset = generated, endIndex = toCopy)
        generated += toCopy
        counter += 1
    }
    return out
}

private fun clientTimezoneOffsetMinutes(): Int =
    -(TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60_000)

private fun parseTimelineSummary(summary: JSONObject?): Map<String, Map<String, Double>> {
    if (summary == null) return emptyMap()
    val out = linkedMapOf<String, Map<String, Double>>()
    val deviceKeys = summary.keys()
    while (deviceKeys.hasNext()) {
        val deviceId = deviceKeys.next()
        val apps = summary.optJSONObject(deviceId) ?: continue
        val appOut = linkedMapOf<String, Double>()
        val appKeys = apps.keys()
        while (appKeys.hasNext()) {
            val appName = appKeys.next()
            appOut[appName] = apps.optDouble(appName, 0.0).coerceAtLeast(0.0)
        }
        out[deviceId] = appOut
    }
    return out
}
