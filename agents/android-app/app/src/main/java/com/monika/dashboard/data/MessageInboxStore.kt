package com.monika.dashboard.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class VisitorMessage(
    val id: String,
    val viewerId: String,
    val text: String,
    val at: Long,
)

object MessageInboxStore {
    private const val PREFS = "visitor_messages"
    private const val KEY_RECENT = "recent"
    private const val MAX_MESSAGES = 20

    fun add(context: Context, id: String, viewerId: String, text: String) {
        if (viewerId.isBlank() || text.isBlank()) return
        val next = listOf(
            VisitorMessage(
                id = id.ifBlank { "${viewerId}_${System.currentTimeMillis()}" },
                viewerId = viewerId,
                text = text.take(500),
                at = System.currentTimeMillis(),
            )
        ) + recent(context).filterNot { it.id == id }
        save(context, next.take(MAX_MESSAGES))
    }

    fun recent(context: Context): List<VisitorMessage> {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_RECENT, "[]")
        return runCatching {
            val arr = JSONArray(raw)
            buildList {
                for (i in 0 until arr.length()) {
                    val item = arr.optJSONObject(i) ?: continue
                    add(
                        VisitorMessage(
                            id = item.optString("id"),
                            viewerId = item.optString("viewer_id"),
                            text = item.optString("text"),
                            at = item.optLong("at"),
                        )
                    )
                }
            }
        }.getOrElse { emptyList() }
    }

    private fun save(context: Context, messages: List<VisitorMessage>) {
        val arr = JSONArray()
        for (message in messages) {
            arr.put(
                JSONObject()
                    .put("id", message.id)
                    .put("viewer_id", message.viewerId)
                    .put("text", message.text)
                    .put("at", message.at)
            )
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_RECENT, arr.toString())
            .apply()
    }
}
