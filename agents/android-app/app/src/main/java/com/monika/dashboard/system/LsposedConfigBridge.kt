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
        val interval = settings.reportInterval.first()
        val uploadFg = settings.uploadForeground.first()
        val uploadMedia = settings.uploadMedia.first()

        // Write to standard SharedPreferences so LSPosed module can read it on boot via getRemotePreferences
        try {
            val prefs = context.getSharedPreferences("monika_lsp_direct_upload", Context.MODE_PRIVATE)
            prefs.edit()
                .putBoolean("enabled", enabled)
                .putString("server_url", url)
                .putString("token", token)
                .putLong("interval_ms", interval * 1000L)
                .putBoolean("upload_foreground", uploadFg)
                .putBoolean("upload_media", uploadMedia)
                .apply()
        } catch (e: Exception) {
            DebugLog.log("LSPosed", "Failed to write shared prefs: ${e.message}")
        }

        val intent = Intent(ACTION_CONFIG).apply {
            putExtra("enabled", enabled)
            putExtra("server_url", url)
            putExtra("token", token)
            putExtra("interval_sec", interval)
            putExtra("upload_foreground", uploadFg)
            putExtra("upload_media", uploadMedia)
        }
        try {
            context.sendBroadcast(intent, PERMISSION)
        } catch (e: Exception) {
            DebugLog.log("LSPosed", "Config broadcast failed: ${e.message}")
        }
        DebugLog.log("LSPosed", if (enabled) "已下发直传配置" else "已通知直传暂停")
    }
}
