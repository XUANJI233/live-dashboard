package com.monika.dashboard.data

import android.content.Context
import org.json.JSONObject

enum class UploadItem(val key: String, val label: String) {
    FOREGROUND("foreground", "当前应用/页面"),
    MEDIA("media", "视频/音乐"),
    NETWORK("network", "网络状态"),
    LOCATION("location", "位置"),
    VPN("vpn", "VPN"),
    INPUT("input", "输入状态"),
    HEALTH("health", "健康数据"),
    WATCH("watch", "手表数据"),
}

data class UploadStatus(
    val ok: Boolean,
    val at: Long,
    val message: String,
)

object UploadStatusStore {
    private const val PREFS = "upload_status"
    private const val LAST_PAYLOAD = "last_payload"

    fun mark(context: Context, item: UploadItem, ok: Boolean, message: String = "") {
        val value = JSONObject()
            .put("ok", ok)
            .put("at", System.currentTimeMillis())
            .put("message", message.take(160))
            .toString()
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(item.key, value)
            .apply()
    }

    fun read(context: Context, item: UploadItem): UploadStatus? {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(item.key, null)
            ?: return null
        return runCatching {
            val json = JSONObject(raw)
            UploadStatus(
                ok = json.optBoolean("ok"),
                at = json.optLong("at"),
                message = json.optString("message"),
            )
        }.getOrNull()
    }

    fun setLastPayload(context: Context, payload: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(LAST_PAYLOAD, payload.take(12_000))
            .apply()
    }

    fun getLastPayload(context: Context): String =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(LAST_PAYLOAD, "").orEmpty()
}
