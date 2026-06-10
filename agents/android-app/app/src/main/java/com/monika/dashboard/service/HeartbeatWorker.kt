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
import com.monika.dashboard.data.PendingReportStore
import com.monika.dashboard.data.ReportCadenceStore
import com.monika.dashboard.data.SettingsStore
import com.monika.dashboard.data.UploadItem
import com.monika.dashboard.data.UploadStatusStore
import com.monika.dashboard.network.ReportClient
import com.monika.dashboard.network.putNormalAndroidCapabilities
import com.monika.dashboard.realtime.DeviceCommandController
import com.monika.dashboard.realtime.MessageSocketManager
import com.monika.dashboard.system.DeviceEnvironment
import com.monika.dashboard.system.DeviceEnvironmentCollector
import com.monika.dashboard.system.RootSystemCollector
import com.monika.dashboard.system.LsposedConfigBridge
import com.monika.dashboard.system.LocationSnapshot
import com.monika.dashboard.system.SystemSnapshot
import com.monika.dashboard.system.SystemSnapshotStore
import com.monika.dashboard.system.isActiveForegroundId
import com.monika.dashboard.system.isSleeping
import kotlinx.coroutines.flow.first
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * App-process heartbeat fallback. LSPosed direct mode is preferred for
 * screen-off and Xiaomi/HyperOS reliability because it uploads from system_server.
 * This self-reschedules OneTimeWorkRequest to bypass the 15-min periodic minimum,
 * but OEM background policies can still delay app-process execution.
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
        private const val SLEEPING_INTERVAL_SECONDS = 3 * 60

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
        val requestedIntervalSec = inputData.getInt(KEY_INTERVAL_SEC, DEFAULT_INTERVAL_SECONDS)
            .coerceAtLeast(MIN_INTERVAL_SECONDS)
        val configuredIntervalSec = runCatching { settings.reportInterval.first() }
            .getOrDefault(requestedIntervalSec)
        val highFrequency = settings.highFrequencyReport.first()
        var nextIntervalSec = if (highFrequency) {
            configuredIntervalSec
        } else {
            configuredIntervalSec.coerceAtLeast(DEFAULT_INTERVAL_SECONDS)
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
            val uploadLocation = settings.uploadLocation.first()
            val uploadVpnStatus = settings.uploadVpnStatus.first()
            val uploadForeground = settings.uploadForeground.first()
            val uploadMedia = settings.uploadMedia.first()
            val uploadNetwork = settings.uploadNetwork.first()

            val battery = getBatteryInfo()
            val snapshot = collectSystemSnapshot(capabilityMode, uploadForeground, uploadMedia)
            val mediaPackage = snapshot.media?.packageName?.takeIf { snapshot.media?.playing == true }
            val sleepingWithoutMedia = snapshot.isSleeping() && mediaPackage == null
            if (sleepingWithoutMedia) {
                nextIntervalSec = nextIntervalSec.coerceAtLeast(SLEEPING_INTERVAL_SECONDS)
            }
            val offlineTimeoutMinutes = if (snapshot.isSleeping()) {
                OfflineTimeoutPolicy.forCadenceSeconds(nextIntervalSec)
            } else {
                null
            }
            val environment = DeviceEnvironmentCollector.collect(
                applicationContext,
                includeAmbientLight = !snapshot.isSleeping(),
            )
            val appId = when {
                snapshot.isSleeping() && mediaPackage != null -> mediaPackage
                snapshot.isSleeping() -> "sleeping"
                else -> snapshot.foreground?.packageName?.takeIf { it.isActiveForegroundId() }
                    ?: mediaPackage
                    ?: snapshot.media?.app
                    ?: "idle"
            }
            val windowTitle = snapshot.primaryDisplayTitle()
            val vpnState = if (uploadVpnStatus) getVpnState() else null
            val location = if (uploadLocation) getLowPowerLocation() else null
            val networkState = if (uploadNetwork) getNetworkState() else null

            // Ensure WebSocket is connected for device_status
            MessageSocketManager.ensureStarted(applicationContext)
            val payloadInput = StatusPayloadInput(
                identity = StatusIdentity(appId, windowTitle),
                telemetry = StatusTelemetry(
                    battery = battery,
                    network = networkState,
                    vpn = vpnState,
                    location = location,
                    snapshot = snapshot,
                    environment = environment,
                ),
                offlineTimeoutMinutes = offlineTimeoutMinutes,
                heartbeatOnly = false,
            )

            // Build JSON payload matching /api/report body structure
            val fullPayload = buildStatusPayload(payloadInput)
            val signature = ReportCadenceStore.signature(appId, windowTitle, snapshot, environment)
            val heartbeatOnly = ReportCadenceStore.shouldSendHeartbeatOnly(applicationContext, signature)
            val payload = if (heartbeatOnly) {
                buildStatusPayload(payloadInput.copy(heartbeatOnly = true))
            } else {
                fullPayload
            }
            UploadStatusStore.setLastPayload(applicationContext, JSONObject(payload).toString(2))

            // Try WebSocket first (fast, persistent, no per-request overhead)
            val wsSent = MessageSocketManager.sendDeviceStatus(payload)
            if (wsSent) {
                ReportCadenceStore.markSent(applicationContext, signature, heartbeatOnly)
                DebugLog.log("心跳Worker", "WS上报成功: $appId ${windowTitle.take(80)}${if (heartbeatOnly) " (心跳)" else ""}")
                markUploadStatuses(uploadForeground, uploadMedia, uploadNetwork, uploadLocation, uploadVpnStatus, true, "OK(ws)")
                Log.i(TAG, "WS heartbeat sent: $appId")
                
                // Sync messages even when WebSocket is used for status reporting
                var client: ReportClient? = null
                try {
                    client = ReportClient(url, token, applicationContext)
                    PendingReportWorker.flush(applicationContext, client)
                    DeviceCommandController.flushPending(applicationContext)
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
                    PendingReportWorker.flush(applicationContext, client)
                    DeviceCommandController.flushPending(applicationContext)
                    syncBlockedViewers(client)
                    val result = client.postReportBody(payload)
                    if (result.isSuccess) {
                        ReportCadenceStore.markSent(applicationContext, signature, heartbeatOnly)
                        DebugLog.log("心跳Worker", "HTTP上报成功: $appId ${windowTitle.take(80)}${if (heartbeatOnly) " (心跳)" else ""}")
                        markUploadStatuses(uploadForeground, uploadMedia, uploadNetwork, uploadLocation, uploadVpnStatus, true, "OK(http)")
                        Log.i(TAG, "HTTP heartbeat sent: $appId")
                    } else {
                        val message = result.exceptionOrNull()?.message ?: "unknown"
                        maybeQueueFullPayload(fullPayload, heartbeatOnly, message)
                        markUploadStatuses(uploadForeground, uploadMedia, uploadNetwork, uploadLocation, uploadVpnStatus, false, message)
                        DebugLog.log("心跳Worker", "HTTP上报失败: $message")
                    }
                } catch (e: Exception) {
                    val message = e.message ?: "error"
                    maybeQueueFullPayload(fullPayload, heartbeatOnly, message)
                    markUploadStatuses(uploadForeground, uploadMedia, uploadNetwork, uploadLocation, uploadVpnStatus, false, message)
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

    private data class StatusIdentity(
        val appId: String,
        val windowTitle: String,
    )

    private data class StatusTelemetry(
        val battery: Pair<Int, Boolean>?,
        val network: NetworkState?,
        val vpn: Pair<Boolean, String?>?,
        val location: LocationSnapshot?,
        val snapshot: SystemSnapshot?,
        val environment: DeviceEnvironment?,
    )

    private data class StatusPayloadInput(
        val identity: StatusIdentity,
        val telemetry: StatusTelemetry,
        val offlineTimeoutMinutes: Int?,
        val heartbeatOnly: Boolean,
    )

    /**
     * Build a JSON payload string compatible with the /api/report body format.
     * This is sent as the "payload" field of a device_status WebSocket message.
     */
    private fun buildStatusPayload(input: StatusPayloadInput): String = JSONObject().apply {
        val telemetry = input.telemetry
        put("app_id", input.identity.appId)
        put("window_title", input.identity.windowTitle)
        put("timestamp", Instant.now().toString())

        val extra = JSONObject()
        telemetry.battery?.let {
            extra.put("battery_percent", it.first)
            extra.put("battery_charging", it.second)
        }
        if (telemetry.snapshot?.isSleeping() == true) extra.put("sleeping", true)

        val device = JSONObject()
        telemetry.network?.let { network ->
            device.put("network_connected", network.connected)
            network.type.takeIf { it.isNotBlank() }?.let { device.put("network_type", it.take(64)) }
            network.cellularGeneration?.takeIf { it.isNotBlank() }?.let {
                device.put("cellular_generation", it.take(64))
            }
        }
        telemetry.vpn?.let { vpn ->
            device.put("vpn_active", vpn.first)
            vpn.second?.takeIf { it.isNotBlank() }?.let { device.put("vpn_name", it.take(64)) }
        }
        telemetry.environment?.audioOutput?.let { audio ->
            device.put("audio_output_connected", audio.connected)
            if (audio.type.isNotBlank()) device.put("audio_output_type", audio.type.take(64))
            if (audio.name.isNotBlank()) device.put("audio_output_name", audio.name.take(64))
        }
        telemetry.environment?.ambientLux?.takeIf { it.isFinite() }?.let { lux ->
            device.put("ambient_lux", (lux.coerceIn(0f, 200_000f) * 10f).toInt() / 10.0)
        }
        putNormalAndroidCapabilities(device)
        if (input.heartbeatOnly) device.put("heartbeat_only", true)
        input.offlineTimeoutMinutes?.let { device.put(OFFLINE_TIMEOUT_FIELD, it) }
        telemetry.snapshot?.let {
            device.put("last_sample_at", Instant.ofEpochMilli(it.sampledAt).toString())
            device.put(
                "energy_policy",
                if (it.capabilityMode == "root") "app_workmanager_root" else "app_workmanager"
            )
        }
        // Device form factor detection
        device.put("device_kind", detectDeviceKind())
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
            val fgObj = JSONObject()
            fg.packageName?.let { fgObj.put("package_name", it.take(64)) }
            fg.appName?.let { fgObj.put("app_name", it.take(64)) }
            fg.activity?.let { fgObj.put("activity", it.take(256)) }
            fg.title?.let { fgObj.put("title", it.take(256)) }
            fgObj.put("source", fg.source)
            fgObj.put("confidence", fg.confidence.coerceIn(0.0, 1.0))
            if (fgObj.length() > 0) extra.put("foreground", fgObj)
        }

        telemetry.snapshot?.media?.let { mediaInfo ->
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
                media = latest.media.takeIf { includeMedia } ?: normal.media,
            )
            val rootSnapshot = RootSystemCollector(applicationContext).collect()
            if (rootSnapshot != null) return rootSnapshot.copy(
                foreground = rootSnapshot.foreground.takeIf { includeForeground } ?: normal.foreground,
                media = rootSnapshot.media.takeIf { includeMedia } ?: normal.media,
            )
        }
        return normal.copy(capabilityMode = mode)
    }

    private fun SystemSnapshot.hasUsefulPrivilegedData(): Boolean {
        val foregroundUseful = isSleeping() ||
            foreground?.packageName?.isActiveForegroundId() == true ||
            foreground?.appName?.isActiveForegroundId() == true ||
            foreground?.title?.isNotBlank() == true ||
            foreground?.activity?.isNotBlank() == true
        return foregroundUseful ||
            media?.title?.isNotBlank() == true ||
            media?.playing == true
    }

    private fun SystemSnapshot.primaryDisplayTitle(): String {
        val mediaTitle = media?.title?.takeIf { media.playing == true && it.isNotBlank() }
        val mediaApp = media?.app?.takeIf { it.isNotBlank() }
        if (isSleeping()) {
            return when {
                mediaTitle != null && mediaApp != null -> "${mediaApp}正在播放${mediaTitle}"
                mediaApp != null -> "${mediaApp}正在播放"
                mediaTitle != null -> "正在播放${mediaTitle}"
                else -> "(-.-)zzZ"
            }
        }
        val appName = foreground?.appName?.takeIf { it.isActiveForegroundId() }
        val foregroundTitle = foreground?.title?.takeIf { it.isNotBlank() }
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
        ok: Boolean,
        message: String,
    ) {
        if (foreground) UploadStatusStore.mark(applicationContext, UploadItem.FOREGROUND, ok, message)
        if (media) UploadStatusStore.mark(applicationContext, UploadItem.MEDIA, ok, message)
        if (network) UploadStatusStore.mark(applicationContext, UploadItem.NETWORK, ok, message)
        if (location) UploadStatusStore.mark(applicationContext, UploadItem.LOCATION, ok, message)
        if (vpn) UploadStatusStore.mark(applicationContext, UploadItem.VPN, ok, message)
    }

    private fun maybeQueueFullPayload(fullPayload: String, heartbeatOnly: Boolean, message: String) {
        if (heartbeatOnly) return
        val queued = PendingReportStore.enqueue(applicationContext, fullPayload, message)
        if (queued != null) {
            PendingReportWorker.schedule(applicationContext)
            DebugLog.log("上报队列", "已保存失败上报，等待网络恢复补传")
        }
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
            if (DeviceCommandController.handlePayloadText(
                    applicationContext,
                    message.payload,
                    source = "message_poll",
                )
            ) {
                continue
            }
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
                message.payload,
            )
        }
    }

    private fun syncBlockedViewers(client: ReportClient) {
        for (viewerId in MessageSocketManager.blockedViewers(applicationContext)) {
            client.blockViewer(viewerId)
        }
    }

    private fun syncMessageHistory(client: ReportClient?) {
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
