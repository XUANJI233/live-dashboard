package com.monika.dashboard.system

import android.content.Context
import android.content.Intent
import com.monika.dashboard.BuildConfig
import com.monika.dashboard.data.DebugLog
import com.monika.dashboard.data.SettingsStore
import kotlinx.coroutines.flow.first

object LsposedConfigBridge {
    private const val ACTION_CONFIG = "com.monika.dashboard.LSPOSED_CONFIG"
    private const val PERMISSION = "com.monika.dashboard.permission.LSPOSED_CONFIG"

    suspend fun publish(context: Context, settings: SettingsStore) {
        if (!BuildConfig.PRIVILEGED_FEATURES || settings.capabilityMode.first() != "lsposed") return
        val token = settings.getToken().orEmpty()
        val url = settings.serverUrl.first()
        val enabled = settings.monitoringEnabled.first()
        val intent = Intent(ACTION_CONFIG).apply {
            putExtra("enabled", enabled)
            putExtra("server_url", url)
            putExtra("token", token)
            putExtra("interval_sec", settings.reportInterval.first())
            putExtra("upload_foreground", settings.uploadForeground.first())
            putExtra("upload_media", settings.uploadMedia.first())
        }
        context.sendBroadcast(intent, PERMISSION)
        DebugLog.log("LSPosed", if (enabled) "已下发直传配置" else "已通知直传暂停")
    }
}
