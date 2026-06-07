package com.monika.dashboard.network

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import android.content.Context
import com.monika.dashboard.data.UploadStatusStore
import com.monika.dashboard.data.VisitorMessage
import java.net.URLEncoder
import java.net.URI
import java.time.Instant
import java.util.TimeZone
import java.util.concurrent.TimeUnit
import com.monika.dashboard.system.LocationSnapshot
import com.monika.dashboard.system.SystemSnapshot
import com.monika.dashboard.system.isSleeping

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

    fun reportApp(
        appId: String,
        windowTitle: String,
        batteryPercent: Int? = null,
        batteryCharging: Boolean? = null,
        networkConnected: Boolean? = null,
        networkType: String? = null,
        cellularGeneration: String? = null,
        vpnActive: Boolean? = null,
        vpnName: String? = null,
        location: LocationSnapshot? = null,
        snapshot: SystemSnapshot? = null,
        musicTitle: String? = null,
        musicArtist: String? = null,
        musicApp: String? = null
    ): Result<Unit> {
        val body = JSONObject().apply {
            put("app_id", appId)
            put("window_title", windowTitle)
            put("timestamp", Instant.now().toString())

            val extra = JSONObject()
            batteryPercent?.let { extra.put("battery_percent", it) }
            batteryCharging?.let { extra.put("battery_charging", it) }
            if (snapshot?.isSleeping() == true) extra.put("sleeping", true)
            val device = JSONObject()
            networkConnected?.let { device.put("network_connected", it) }
            networkType?.takeIf { it.isNotBlank() }?.let { device.put("network_type", it.take(64)) }
            cellularGeneration?.takeIf { it.isNotBlank() }?.let { device.put("cellular_generation", it.take(64)) }
            vpnActive?.let { device.put("vpn_active", it) }
            vpnName?.let { device.put("vpn_name", it.take(64)) }
            snapshot?.let {
                device.put("capability_mode", it.capabilityMode)
                device.put("last_sample_at", Instant.ofEpochMilli(it.sampledAt).toString())
                device.put(
                    "energy_policy",
                    if (it.capabilityMode == "root") "app_workmanager_root" else "app_workmanager"
                )
            }
            if (device.length() > 0) extra.put("device", device)

            location?.let { loc ->
                extra.put("location", JSONObject().apply {
                    put("latitude", loc.latitude)
                    put("longitude", loc.longitude)
                    loc.accuracyMeters?.let { put("accuracy_m", it.toDouble()) }
                    loc.provider?.let { put("provider", it.take(64)) }
                    put("recorded_at", Instant.ofEpochMilli(loc.recordedAt).toString())
                })
            }

            snapshot?.foreground?.let { fg ->
                val foreground = JSONObject()
                fg.packageName?.let { foreground.put("package_name", it.take(64)) }
                fg.appName?.let { foreground.put("app_name", it.take(64)) }
                fg.activity?.let { foreground.put("activity", it.take(256)) }
                fg.title?.let { foreground.put("title", it.take(256)) }
                foreground.put("source", fg.source)
                foreground.put("confidence", fg.confidence.coerceIn(0.0, 1.0))
                if (foreground.length() > 0) extra.put("foreground", foreground)
            }

            snapshot?.input?.let { inputInfo ->
                val input = JSONObject()
                inputInfo.inputActive?.let { input.put("input_active", it) }
                inputInfo.isTyping?.let { input.put("is_typing", it) }
                input.put("source", inputInfo.source)
                if (input.length() > 0) extra.put("input", input)
            }

            snapshot?.media?.let { mediaInfo ->
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

            if (musicTitle != null) {
                val music = JSONObject()
                music.put("title", musicTitle.take(256))
                musicArtist?.let { music.put("artist", it.take(256)) }
                musicApp?.let { music.put("app", it.take(64)) }
                extra.put("music", music)
            }

            if (extra.length() > 0) {
                put("extra", extra)
            }
        }

        context?.let { UploadStatusStore.setLastPayload(it, body.toString(2)) }
        return post("${serverUrl.trimEnd('/')}/api/report", body)
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
                    ),
                )
            }
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

    private fun post(url: String, body: JSONObject): Result<Unit> {
        val request = Request.Builder()
            .url(url)
            .addHeader("Authorization", "Bearer $token")
            .addHeader("Content-Type", "application/json")
            .post(body.toString().toRequestBody(jsonMediaType))
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
    )
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
