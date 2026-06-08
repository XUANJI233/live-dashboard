package com.monika.dashboard.system

import android.content.Context
import android.content.Intent
import com.monika.dashboard.BuildConfig
import com.monika.dashboard.data.DebugLog
import com.monika.dashboard.data.SettingsStore
import kotlinx.coroutines.flow.first
import java.util.UUID

object LsposedConfigBridge {
    private const val ACTION_CONFIG = "com.monika.dashboard.LSPOSED_CONFIG"
    private const val PERMISSION = "com.monika.dashboard.permission.LSPOSED_CONFIG"
    private const val PREFS_NAME = "monika_lsp_direct_upload"
    private const val KEY_BROWSER_TITLE_NONCE = "browser_title_nonce"
    private const val EXTRA_COMMAND = "command"
    private const val COMMAND_CLEAR_SUPERVISION_FREEZE = "clear_supervision_freeze"

    suspend fun publish(context: Context, settings: SettingsStore) {
        if (!BuildConfig.PRIVILEGED_FEATURES) return
        val capabilityMode = settings.capabilityMode.first()
        val token = settings.getToken().orEmpty()
        val url = settings.serverUrl.first()
        val enabled = settings.monitoringEnabled.first() && capabilityMode == "lsposed"
        val interval = settings.reportInterval.first()
        val uploadFg = settings.uploadForeground.first()
        val uploadMedia = settings.uploadMedia.first()
        val uploadNetwork = settings.uploadNetwork.first()
        val uploadVpn = settings.uploadVpnStatus.first()
        val browserTitleNonce = getOrCreateBrowserTitleNonce(context)

        // Write to standard SharedPreferences so LSPosed module can read it on boot via getRemotePreferences
        try {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            prefs.edit()
                .putBoolean("enabled", enabled)
                .putString("server_url", url)
                .putString("token", token)
                .putLong("interval_ms", interval * 1000L)
                .putBoolean("upload_foreground", uploadFg)
                .putBoolean("upload_media", uploadMedia)
                .putBoolean("upload_network", uploadNetwork)
                .putBoolean("upload_vpn", uploadVpn)
                .putBoolean("upload_input", false)
                .putString(KEY_BROWSER_TITLE_NONCE, browserTitleNonce)
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
            putExtra("upload_network", uploadNetwork)
            putExtra("upload_vpn", uploadVpn)
            putExtra("upload_input", false)
            putExtra(KEY_BROWSER_TITLE_NONCE, browserTitleNonce)
        }
        try {
            context.sendBroadcast(intent, PERMISSION)
        } catch (e: Exception) {
            DebugLog.log("LSPosed", "Config broadcast failed: ${e.message}")
        }
        DebugLog.log("LSPosed", if (enabled) "已下发直传配置" else "已通知直传暂停")
    }

    fun clearSupervisionFreeze(context: Context): Boolean {
        if (!BuildConfig.PRIVILEGED_FEATURES) return false
        val intent = Intent(ACTION_CONFIG).apply {
            putExtra(EXTRA_COMMAND, COMMAND_CLEAR_SUPERVISION_FREEZE)
        }
        return try {
            context.sendBroadcast(intent, PERMISSION)
            DebugLog.log("LSPosed", "已请求清空监督冻结状态")
            true
        } catch (e: Exception) {
            DebugLog.log("LSPosed", "清空监督冻结广播失败: ${e.message}")
            false
        }
    }

    private fun getOrCreateBrowserTitleNonce(context: Context): String {
        return try {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val existing = prefs.getString(KEY_BROWSER_TITLE_NONCE, null)
                ?.takeIf { it.length >= 24 }
            if (existing != null) {
                existing
            } else {
                val created = UUID.randomUUID().toString().replace("-", "")
                prefs.edit().putString(KEY_BROWSER_TITLE_NONCE, created).apply()
                created
            }
        } catch (e: Exception) {
            DebugLog.log("LSPosed", "Failed to prepare browser title nonce: ${e.message}")
            UUID.randomUUID().toString().replace("-", "")
        }
    }
}
