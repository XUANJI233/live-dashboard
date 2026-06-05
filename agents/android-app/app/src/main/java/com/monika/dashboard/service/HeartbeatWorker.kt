package com.monika.dashboard.service

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.telephony.TelephonyManager
import android.util.Log
import androidx.work.*
import com.monika.dashboard.BuildConfig
import com.monika.dashboard.data.DebugLog
import com.monika.dashboard.data.MessageInboxStore
import com.monika.dashboard.data.SettingsStore
import com.monika.dashboard.data.UploadItem
import com.monika.dashboard.data.UploadStatusStore
import com.monika.dashboard.network.ReportClient
import com.monika.dashboard.realtime.MessageSocketManager
import com.monika.dashboard.system.RootSystemCollector
import com.monika.dashboard.system.LsposedConfigBridge
import com.monika.dashboard.system.LocationSnapshot
import com.monika.dashboard.system.SystemSnapshot
import com.monika.dashboard.system.SystemSnapshotStore
import kotlinx.coroutines.flow.first
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * WorkManager-based heartbeat that survives Xiaomi/HyperOS process freezer.
 * Uses self-rescheduling OneTimeWorkRequest to bypass the 15-min periodic minimum.
 * AlarmManager under the hood wakes the app even when frozen by cgroup freezer.
 */
class HeartbeatWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    companion object {
        private const val TAG = "Heartbeat"
        private const val WORK_NAME = "heartbeat_report"
        private const val KEY_INTERVAL_SEC = "interval_sec"
        const val MIN_INTERVAL_SECONDS = 5
        const val MAX_INTERVAL_SECONDS = 50
        const val DEFAULT_INTERVAL_SECONDS = 30

        fun schedule(context: Context, intervalSeconds: Int = DEFAULT_INTERVAL_SECONDS) {
            val safe = intervalSeconds.coerceIn(MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS)
            enqueueNext(context, safe)
            DebugLog.log("心跳Worker", "已启动，间隔 ${safe} 秒")
            Log.i(TAG, "Scheduled heartbeat every ${safe}s")
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
            DebugLog.log("心跳Worker", "已取消")
            Log.i(TAG, "Cancelled heartbeat")
        }

        private fun enqueueNext(context: Context, intervalSec: Int) {
            val request = OneTimeWorkRequestBuilder<HeartbeatWorker>()
                .setInitialDelay(intervalSec.toLong(), TimeUnit.SECONDS)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                )
                .setInputData(workDataOf(KEY_INTERVAL_SEC to intervalSec))
                .build()

            WorkManager.getInstance(context).enqueueUniqueWork(
                WORK_NAME,
                ExistingWorkPolicy.REPLACE,
                request
            )
        }
    }

    override suspend fun doWork(): Result {
        val settings = SettingsStore(applicationContext)
        val intervalSec = inputData.getInt(KEY_INTERVAL_SEC, DEFAULT_INTERVAL_SECONDS)
        val highFrequency = settings.highFrequencyReport.first()
        val nextIntervalSec = if (highFrequency) {
            intervalSec
        } else {
            intervalSec.coerceAtLeast(DEFAULT_INTERVAL_SECONDS)
        }

        try {
            val enabled = settings.monitoringEnabled.first()
            if (!enabled) {
                DebugLog.log("心跳Worker", "监听未开启，跳过")
                return Result.success()
            }

            val url = settings.serverUrl.first()
            val token = settings.getToken()
            if (url.isEmpty() || token.isNullOrEmpty()) {
                DebugLog.log("心跳Worker", "URL或Token未配置，跳过")
                return Result.success()
            }

            // ── LSPosed mode: app is only a configurator, do NOT upload anything ──
            val capabilityMode = settings.capabilityMode.first()
            if (BuildConfig.PRIVILEGED_FEATURES && capabilityMode == "lsposed") {
                try { LsposedConfigBridge.publish(applicationContext, settings) } catch (e: Exception) {
                    Log.e(TAG, "LsposedConfigBridge.publish failed", e)
                }
                DebugLog.log("心跳Worker", "LSPosed直传模式，APK仅下发配置，不做上传")
                return Result.success()
            }

            // ── Normal / Root mode: collect data and send via WebSocket device_status ──
            val uploadInputState = settings.uploadInputState.first()
            val uploadLocation = settings.uploadLocation.first()
            val uploadVpnStatus = settings.uploadVpnStatus.first()
            val uploadForeground = settings.uploadForeground.first()
            val uploadMedia = settings.uploadMedia.first()
            val uploadNetwork = settings.uploadNetwork.first()

            val battery = getBatteryInfo()
            val snapshot = collectSystemSnapshot(capabilityMode, uploadInputState, uploadForeground, uploadMedia)
            val appId = snapshot.foreground?.packageName?.takeIf { it.isNotBlank() && it != "idle" }
                ?: snapshot.media?.packageName?.takeIf { snapshot.media?.playing == true }
                ?: snapshot.media?.app
                ?: "idle"
            val windowTitle = snapshot.primaryDisplayTitle()
            val vpnState = if (uploadVpnStatus) getVpnState() else null
            val location = if (uploadLocation) getLowPowerLocation() else null
            val networkState = if (uploadNetwork) getNetworkState() else null

            // Ensure WebSocket is connected for device_status
            MessageSocketManager.ensureStarted(applicationContext)

            // Build JSON payload matching /api/report body structure
            val payload = buildStatusPayload(
                appId, windowTitle,
                batteryPercent = battery?.first,
                batteryCharging = battery?.second,
                networkConnected = networkState?.connected,
                networkType = networkState?.type,
                cellularGeneration = networkState?.cellularGeneration,
                vpnActive = vpnState?.first,
                vpnName = vpnState?.second,
                location = location,
                snapshot = snapshot,
            )

            // Try WebSocket first (fast, persistent, no per-request overhead)
            val wsSent = MessageSocketManager.sendDeviceStatus(payload)
            if (wsSent) {
                DebugLog.log("心跳Worker", "WS上报成功: $appId ${windowTitle.take(80)}")
                markUploadStatuses(uploadForeground, uploadMedia, uploadNetwork, uploadLocation, uploadVpnStatus, uploadInputState, true, "OK(ws)")
                Log.i(TAG, "WS heartbeat sent: $appId")
                
                // Sync messages even when WebSocket is used for status reporting
                var client: ReportClient? = null
                try {
                    client = ReportClient(url, token, applicationContext)
                    syncBlockedViewers(client)
                    syncMessageHistory(client)
                    pollMessages(client)
                } catch (e: Exception) {
                    DebugLog.log("心跳Worker", "WS消息同步失败: ${e.message}")
                    Log.e(TAG, "Message sync failed after WS heartbeat", e)
                } finally {
                    runCatching { client?.shutdown() }
                }
            } else {
                // Fallback to HTTP for backward compatibility
                var client: ReportClient? = null
                try {
                    client = ReportClient(url, token, applicationContext)
                    syncBlockedViewers(client)
                    val result = client.reportApp(
                        appId = appId,
                        windowTitle = windowTitle,
                        batteryPercent = battery?.first,
                        batteryCharging = battery?.second,
                        networkConnected = networkState?.connected,
                        networkType = networkState?.type,
                        cellularGeneration = networkState?.cellularGeneration,
                        vpnActive = vpnState?.first,
                        vpnName = vpnState?.second,
                        location = location,
                        snapshot = snapshot
                    )
                    if (result.isSuccess) {
                        DebugLog.log("心跳Worker", "HTTP上报成功: $appId ${windowTitle.take(80)}")
                        markUploadStatuses(uploadForeground, uploadMedia, uploadNetwork, uploadLocation, uploadVpnStatus, uploadInputState, true, "OK(http)")
                        Log.i(TAG, "HTTP heartbeat sent: $appId")
                    } else {
                        val message = result.exceptionOrNull()?.message ?: "unknown"
                        markUploadStatuses(uploadForeground, uploadMedia, uploadNetwork, uploadLocation, uploadVpnStatus, uploadInputState, false, message)
                        DebugLog.log("心跳Worker", "HTTP上报失败: $message")
                    }
                } catch (e: Exception) {
                    markUploadStatuses(uploadForeground, uploadMedia, uploadNetwork, uploadLocation, uploadVpnStatus, uploadInputState, false, e.message ?: "error")
                    DebugLog.log("心跳Worker", "HTTP异常: ${e.message}")
                    Log.e(TAG, "Heartbeat HTTP error", e)
                } finally {
                    runCatching { syncMessageHistory(client) }
                    runCatching { pollMessages(client) }
                    runCatching { client?.shutdown() }
                }
            }
        } catch (e: Exception) {
            // Top-level catch: log but never crash — always reschedule
            Log.e(TAG, "HeartbeatWorker unexpected error", e)
            DebugLog.log("心跳Worker", "未预期异常: ${e.message}")
        } finally {
            // Always reschedule next heartbeat, even on error
            enqueueNext(applicationContext, nextIntervalSec)
        }
        return Result.success()
    }

    /**
     * Build a JSON payload string compatible with the /api/report body format.
     * This is sent as the "payload" field of a device_status WebSocket message.
     */
    private fun buildStatusPayload(
        appId: String,
        windowTitle: String,
        batteryPercent: Int?,
        batteryCharging: Boolean?,
        networkConnected: Boolean?,
        networkType: String?,
        cellularGeneration: String?,
        vpnActive: Boolean?,
        vpnName: String?,
        location: LocationSnapshot?,
        snapshot: SystemSnapshot?,
    ): String = JSONObject().apply {
        put("app_id", appId)
        put("window_title", windowTitle)
        put("timestamp", Instant.now().toString())

        val extra = JSONObject()
        batteryPercent?.let { extra.put("battery_percent", it) }
        batteryCharging?.let { extra.put("battery_charging", it) }

        val device = JSONObject()
        networkConnected?.let { device.put("network_connected", it) }
        networkType?.takeIf { it.isNotBlank() }?.let { device.put("network_type", it.take(64)) }
        cellularGeneration?.takeIf { it.isNotBlank() }?.let { device.put("cellular_generation", it.take(64)) }
        vpnActive?.let { device.put("vpn_active", it) }
        vpnName?.takeIf { !it.isNullOrBlank() }?.let { device.put("vpn_name", it.take(64)) }
        snapshot?.let {
            device.put("capability_mode", it.capabilityMode)
            device.put("last_sample_at", Instant.ofEpochMilli(it.sampledAt).toString())
        }
        // Device form factor detection
        device.put("device_kind", detectDeviceKind())
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
            val fgObj = JSONObject()
            fg.packageName?.let { fgObj.put("package_name", it.take(64)) }
            fg.appName?.let { fgObj.put("app_name", it.take(64)) }
            fg.activity?.let { fgObj.put("activity", it.take(256)) }
            fg.title?.let { fgObj.put("title", it.take(256)) }
            fgObj.put("source", fg.source)
            fgObj.put("confidence", fg.confidence.coerceIn(0.0, 1.0))
            if (fgObj.length() > 0) extra.put("foreground", fgObj)
        }

        snapshot?.input?.let { inputInfo ->
            val inputObj = JSONObject()
            inputInfo.inputActive?.let { inputObj.put("input_active", it) }
            inputInfo.isTyping?.let { inputObj.put("is_typing", it) }
            inputObj.put("source", inputInfo.source)
            if (inputObj.length() > 0) extra.put("input", inputObj)
        }

        snapshot?.media?.let { mediaInfo ->
            val mediaObj = JSONObject()
            mediaInfo.playing?.let { mediaObj.put("playing", it) }
            mediaInfo.title?.let { mediaObj.put("title", it.take(256)) }
            mediaInfo.artist?.let { mediaObj.put("artist", it.take(256)) }
            mediaInfo.app?.let { mediaObj.put("app", it.take(64)) }
            mediaInfo.packageName?.let { mediaObj.put("package_name", it.take(64)) }
            mediaInfo.state?.let { mediaObj.put("state", it.take(64)) }
            mediaObj.put("source", mediaInfo.source)
            if (mediaObj.length() > 0) extra.put("media", mediaObj)
        }

        if (extra.length() > 0) put("extra", extra)
    }.toString()

    private fun getBatteryInfo(): Pair<Int, Boolean>? {
        return try {
            val intent = applicationContext.registerReceiver(
                null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)
            )
            intent?.let {
                val level = it.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
                val scale = it.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
                val status = it.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
                if (level >= 0 && scale > 0) {
                    val percent = (level * 100) / scale
                    val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                        status == BatteryManager.BATTERY_STATUS_FULL
                    Pair(percent, charging)
                } else null
            }
        } catch (_: Exception) {
            null
        }
    }

    private suspend fun collectSystemSnapshot(
        mode: String,
        includeInput: Boolean,
        includeForeground: Boolean,
        includeMedia: Boolean,
    ): SystemSnapshot {
        val normal = SystemSnapshotStore.mergedNormalSnapshot(includeForeground, includeMedia)
        if (!BuildConfig.PRIVILEGED_FEATURES) {
            return normal
        }
        if (mode == "lsposed") {
            val latest = SystemSnapshotStore.latestLsposedFresh()
            if (latest != null && latest.hasUsefulPrivilegedData()) return latest.copy(
                foreground = latest.foreground.takeIf { includeForeground } ?: normal.foreground,
                input = latest.input.takeIf { includeInput },
                media = latest.media.takeIf { includeMedia } ?: normal.media,
            )
            val rootSnapshot = RootSystemCollector(applicationContext).collect()
            if (rootSnapshot != null) return rootSnapshot.copy(
                foreground = rootSnapshot.foreground.takeIf { includeForeground } ?: normal.foreground,
                input = rootSnapshot.input.takeIf { includeInput },
                media = rootSnapshot.media.takeIf { includeMedia } ?: normal.media,
            )
        }
        return normal.copy(capabilityMode = mode)
    }

    private fun SystemSnapshot.hasUsefulPrivilegedData(): Boolean {
        val foregroundUseful = foreground?.packageName?.takeIf { it != "idle" }?.isNotBlank() == true ||
            foreground?.appName?.takeIf { it != "idle" }?.isNotBlank() == true ||
            foreground?.title?.isNotBlank() == true ||
            foreground?.activity?.isNotBlank() == true
        return foregroundUseful ||
            input?.inputActive != null ||
            media?.title?.isNotBlank() == true ||
            media?.playing == true
    }

    private fun SystemSnapshot.primaryDisplayTitle(): String {
        val appName = foreground?.appName?.takeIf { it.isNotBlank() && it != "idle" }
        val foregroundTitle = foreground?.title?.takeIf { it.isNotBlank() }
        val mediaTitle = media?.title?.takeIf { media.playing == true && it.isNotBlank() }
        val mediaApp = media?.app?.takeIf { it.isNotBlank() }
        return when {
            appName != null && mediaTitle != null && mediaApp != null && mediaApp != appName ->
                "正在用${appName}，后台${mediaApp}正在播放${mediaTitle}"
            appName != null && mediaTitle != null ->
                "正在用${appName}播放${mediaTitle}"
            appName == null && mediaTitle != null && mediaApp != null ->
                "${mediaApp}正在播放${mediaTitle}"
            appName == null && mediaTitle != null ->
                "正在播放${mediaTitle}"
            appName != null && foregroundTitle != null ->
                "正在用${appName}看${foregroundTitle}"
            appName != null -> "正在用${appName}"
            else -> ""
        }
    }

    private fun markUploadStatuses(
        foreground: Boolean,
        media: Boolean,
        network: Boolean,
        location: Boolean,
        vpn: Boolean,
        input: Boolean,
        ok: Boolean,
        message: String,
    ) {
        if (foreground) UploadStatusStore.mark(applicationContext, UploadItem.FOREGROUND, ok, message)
        if (media) UploadStatusStore.mark(applicationContext, UploadItem.MEDIA, ok, message)
        if (network) UploadStatusStore.mark(applicationContext, UploadItem.NETWORK, ok, message)
        if (location) UploadStatusStore.mark(applicationContext, UploadItem.LOCATION, ok, message)
        if (vpn) UploadStatusStore.mark(applicationContext, UploadItem.VPN, ok, message)
        if (input) UploadStatusStore.mark(applicationContext, UploadItem.INPUT, ok, message)
    }

    /** Detect device form factor: "phone", "tablet", or "foldable" */
    private fun detectDeviceKind(): String {
        return try {
            // MIUI: miui.os.Build.IS_TABLET
            try {
                val miuiBuild = Class.forName("miui.os.Build")
                val isTablet = miuiBuild.getDeclaredField("IS_TABLET").get(null) as? Boolean
                if (isTablet == true) return "tablet"
            } catch (_: Throwable) {}
            // AOSP: smallest width >= 600dp
            val config = applicationContext.resources.configuration
            if (config.smallestScreenWidthDp >= 600) "tablet" else "phone"
        } catch (_: Throwable) {
            "phone"
        }
    }

    private data class NetworkState(
        val connected: Boolean,
        val type: String,
        val cellularGeneration: String? = null,
    )

    private fun getNetworkState(): NetworkState? {
        return try {
            val cm = applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            val network = cm?.activeNetwork ?: return NetworkState(false, "offline")
            val caps = cm.getNetworkCapabilities(network) ?: return NetworkState(false, "offline")
            val connected = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            val cellularGeneration = if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
                detectCellularGeneration()
            } else {
                null
            }
            val type = when {
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> cellularGeneration ?: "Cellular"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "Ethernet"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH) -> "Bluetooth"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "VPN"
                else -> if (connected) "Online" else "offline"
            }
            NetworkState(connected, type, cellularGeneration)
        } catch (_: Exception) {
            null
        }
    }

    @SuppressLint("MissingPermission")
    private fun detectCellularGeneration(): String? {
        return try {
            val tm = applicationContext.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
                ?: return null
            val hasReadPhoneState = applicationContext.checkSelfPermission(android.Manifest.permission.READ_PHONE_STATE) ==
                PackageManager.PERMISSION_GRANTED
            val hasReadBasicPhoneState = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                applicationContext.checkSelfPermission(android.Manifest.permission.READ_BASIC_PHONE_STATE) ==
                PackageManager.PERMISSION_GRANTED
            if (!hasReadPhoneState && !hasReadBasicPhoneState) return null
            val dataNetworkType = try {
                tm.dataNetworkType
            } catch (_: SecurityException) {
                return null
            }
            when (dataNetworkType) {
                TelephonyManager.NETWORK_TYPE_NR -> "5G"
                TelephonyManager.NETWORK_TYPE_LTE,
                TelephonyManager.NETWORK_TYPE_IWLAN -> "4G"
                TelephonyManager.NETWORK_TYPE_HSPAP,
                TelephonyManager.NETWORK_TYPE_HSPA,
                TelephonyManager.NETWORK_TYPE_HSDPA,
                TelephonyManager.NETWORK_TYPE_HSUPA,
                TelephonyManager.NETWORK_TYPE_UMTS,
                TelephonyManager.NETWORK_TYPE_EVDO_0,
                TelephonyManager.NETWORK_TYPE_EVDO_A,
                TelephonyManager.NETWORK_TYPE_EVDO_B,
                TelephonyManager.NETWORK_TYPE_EHRPD -> "3G"
                TelephonyManager.NETWORK_TYPE_EDGE,
                TelephonyManager.NETWORK_TYPE_GPRS,
                TelephonyManager.NETWORK_TYPE_CDMA,
                TelephonyManager.NETWORK_TYPE_1xRTT,
                TelephonyManager.NETWORK_TYPE_IDEN -> "2G"
                else -> "Cellular"
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun getVpnState(): Pair<Boolean, String?>? {
        return try {
            val cm = applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
                ?: return null
            for (network in cm.allNetworks) {
                val caps = cm.getNetworkCapabilities(network) ?: continue
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                    return Pair(true, null)
                }
            }
            Pair(false, null)
        } catch (_: Exception) {
            null
        }
    }

    private fun getLowPowerLocation(): LocationSnapshot? {
        return try {
            val fine = applicationContext.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED
            val coarse = applicationContext.checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED
            if (!fine && !coarse) return null

            val lm = applicationContext.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
                ?: return null
            val providers = listOf(
                LocationManager.PASSIVE_PROVIDER,
                LocationManager.NETWORK_PROVIDER,
                LocationManager.GPS_PROVIDER,
            )
            val best = providers.mapNotNull { provider ->
                runCatching { lm.getLastKnownLocation(provider) }.getOrNull()
            }.maxByOrNull { it.time } ?: return null

            // Reject location data older than 30 minutes
            val maxAgeMs = 30 * 60 * 1000L
            val locationAge = System.currentTimeMillis() - best.time
            if (locationAge > maxAgeMs) {
                DebugLog.log("心跳Worker", "位置数据过期 (${locationAge / 1000}s), 跳过上报")
                return null
            }

            LocationSnapshot(
                latitude = best.latitude,
                longitude = best.longitude,
                accuracyMeters = if (best.hasAccuracy()) best.accuracy else null,
                provider = best.provider,
                recordedAt = best.time.takeIf { it > 0L } ?: System.currentTimeMillis(),
            )
        } catch (_: SecurityException) {
            null
        } catch (_: Exception) {
            null
        }
    }

    private fun pollMessages(client: ReportClient?) {
        val safeClient = client ?: return
        val messages = safeClient.fetchMessages().getOrNull().orEmpty()
        for (message in messages) {
            if (MessageSocketManager.isViewerBlocked(applicationContext, message.viewerId)) {
                DebugLog.log("消息", "已忽略拉黑访客队列消息: ${message.viewerId}")
                continue
            }
            MessageSocketManager.notifyIncoming(
                applicationContext,
                message.text,
                message.viewerId,
                message.id,
                message.viewerName,
                message.kind,
            )
        }
    }

    private fun syncBlockedViewers(client: ReportClient) {
        for (viewerId in MessageSocketManager.blockedViewers(applicationContext)) {
            client.blockViewer(viewerId)
        }
    }

    private fun syncMessageHistory(client: ReportClient?) {
            // Skip HTTP poll when WebSocket is healthy — avoid duplicate syncing
            if (MessageSocketManager.isHealthy()) return
        val safeClient = client ?: return
        val latest = MessageInboxStore.latestServerTimestamp(applicationContext)
        val since = latest.takeIf { it.isNotBlank() }
        val messages = safeClient.fetchMessageHistory(since).getOrNull().orEmpty()
        if (messages.isNotEmpty()) {
            MessageInboxStore.upsertAll(applicationContext, messages)
            DebugLog.log("消息", "已同步 ${messages.size} 条消息")
        }
    }
}
