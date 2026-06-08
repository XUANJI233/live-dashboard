package com.monika.dashboard.data

import android.content.Context
import com.monika.dashboard.system.DeviceEnvironment
import com.monika.dashboard.system.SystemSnapshot
import org.json.JSONObject

object ReportCadenceStore {
    private const val PREFS = "report_cadence"
    private const val KEY_SIGNATURE = "signature"
    private const val KEY_LAST_FULL_AT = "last_full_at"
    private const val FULL_REPORT_INTERVAL_MS = 5 * 60 * 1000L

    fun signature(
        appId: String,
        windowTitle: String,
        snapshot: SystemSnapshot?,
        environment: DeviceEnvironment?,
    ): String {
        val media = snapshot?.media
        val foreground = snapshot?.foreground
        val audio = environment?.audioOutput
        return JSONObject()
            .put("app_id", appId)
            .put("title", windowTitle.take(256))
            .put("fg_pkg", foreground?.packageName.orEmpty())
            .put("fg_title", foreground?.title.orEmpty().take(256))
            .put("media_playing", media?.playing == true)
            .put("media_pkg", media?.packageName.orEmpty())
            .put("media_title", media?.title.orEmpty().take(256))
            .put("audio_connected", audio?.connected == true)
            .put("audio_type", audio?.type.orEmpty())
            .toString()
    }

    fun shouldSendHeartbeatOnly(context: Context, signature: String, now: Long = System.currentTimeMillis()): Boolean {
        val prefs = prefs(context)
        if (signature.isBlank()) return false
        if (prefs.getString(KEY_SIGNATURE, "") != signature) return false
        val lastFull = prefs.getLong(KEY_LAST_FULL_AT, 0L)
        return lastFull > 0L && now - lastFull < FULL_REPORT_INTERVAL_MS
    }

    fun markSent(context: Context, signature: String, heartbeatOnly: Boolean, now: Long = System.currentTimeMillis()) {
        val edit = prefs(context).edit().putString(KEY_SIGNATURE, signature)
        if (!heartbeatOnly) edit.putLong(KEY_LAST_FULL_AT, now)
        edit.apply()
    }

    fun clearForTest(context: Context) {
        prefs(context).edit().clear().commit()
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
