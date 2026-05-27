package com.monika.dashboard.service

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
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

        val enabled = settings.monitoringEnabled.first()
        if (!enabled) {
            DebugLog.log("心跳Worker", "监听未开启，跳过")
            return Result.success()
        }

        val url = settings.serverUrl.first()
        val token = settings.getToken()
        if (url.isEmpty() || token.isNullOrEmpty()) {
            DebugLog.log("心跳Worker", "URL或Token未配置，跳过")
            enqueueNext(applicationContext, nextIntervalSec)
            return Result.success()
        }

        var client: ReportClient? = null
        try {
            client = ReportClient(url, token, applicationContext)
            syncBlockedViewers(client)

            val battery = getBatteryInfo()
            val capabilityMode = settings.capabilityMode.first()
            val uploadInputState = settings.uploadInputState.first()
            val uploadLocation = settings.uploadLocation.first()
            val uploadVpnStatus = settings.uploadVpnStatus.first()
            val uploadForeground = settings.uploadForeground.first()
            val uploadMedia = settings.uploadMedia.first()
            val uploadNetwork = settings.uploadNetwork.first()
            if (BuildConfig.PRIVILEGED_FEATURES && capabilityMode == "lsposed") {
                LsposedConfigBridge.publish(applicationContext, settings)
                DebugLog.log("心跳Worker", "LSPosed直传模式，APK跳过状态上报")
                return Result.success()
            }
            val snapshot = collectSystemSnapshot(capabilityMode, uploadInputState, uploadForeground, uploadMedia)
            val appId = snapshot.foreground?.packageName
                ?: snapshot.media?.packageName
                ?: snapshot.media?.app
                ?: "idle"
            val windowTitle = snapshot.primaryDisplayTitle()
            val vpnState = if (uploadVpnStatus) getVpnState() else null
            val location = if (uploadLocation) getLowPowerLocation() else null
            val networkState = if (uploadNetwork) getNetworkState() else null

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
                DebugLog.log("心跳Worker", "上报成功: $appId ${windowTitle.take(80)}")
                markUploadStatuses(uploadForeground, uploadMedia, uploadNetwork, uploadLocation, uploadVpnStatus, uploadInputState, true, "OK")
                Log.i(TAG, "Heartbeat sent: $appId")
            } else {
                val message = result.exceptionOrNull()?.message ?: "unknown"
                markUploadStatuses(uploadForeground, uploadMedia, uploadNetwork, uploadLocation, uploadVpnStatus, uploadInputState, false, message)
                DebugLog.log("心跳Worker", "上报失败: $message")
            }
        } catch (e: Exception) {
            markUploadStatuses(true, true, true, true, true, true, false, e.message ?: "error")
            DebugLog.log("心跳Worker", "异常: ${e.message}")
            Log.e(TAG, "Heartbeat error", e)
        } finally {
            MessageSocketManager.ensureStarted(applicationContext)
            runCatching { syncMessageHistory(client) }
            runCatching { pollMessages(client) }
            runCatching { client?.shutdown() }
        }

        // Always reschedule next heartbeat
        enqueueNext(applicationContext, nextIntervalSec)
        return Result.success()
    }

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
        return foreground?.packageName?.isNotBlank() == true ||
            foreground?.appName?.isNotBlank() == true ||
            foreground?.title?.isNotBlank() == true ||
            foreground?.activity?.isNotBlank() == true ||
            input?.inputActive != null ||
            media?.title?.isNotBlank() == true ||
            media?.playing == true
    }

    private fun SystemSnapshot.primaryDisplayTitle(): String {
        val appName = foreground?.appName?.takeIf { it.isNotBlank() }
        val foregroundTitle = foreground?.title?.takeIf { it.isNotBlank() }
        val mediaTitle = media?.title?.takeIf { media.playing == true && it.isNotBlank() }
        val mediaApp = media?.app?.takeIf { it.isNotBlank() }
        return when {
            appName != null && mediaTitle != null && mediaApp != null && mediaApp != appName ->
                "正在用${appName}，后台${mediaApp}正在播放${mediaTitle}"
            appName != null && mediaTitle != null ->
                "正在用${appName}播放${mediaTitle}"
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

    private fun detectCellularGeneration(): String? {
        return try {
            val tm = applicationContext.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
                ?: return null
            when (tm.dataNetworkType) {
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
