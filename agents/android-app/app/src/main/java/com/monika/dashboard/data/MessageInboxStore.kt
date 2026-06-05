package com.monika.dashboard.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class VisitorMessage(
    val id: String,
    val viewerId: String,
    val viewerName: String,
    val viewerRemark: String,
    val kind: String,
    val direction: String,
    val text: String,
    val at: Long,
)

object MessageInboxStore {
    private const val PREFS = "visitor_messages"
    private const val KEY_RECENT = "recent"
    private const val MAX_MESSAGES = 500

    // In-memory cache — initialized lazily from SharedPreferences
    private val _messages = MutableStateFlow<List<VisitorMessage>>(emptyList())
    val messages: StateFlow<List<VisitorMessage>> = _messages.asStateFlow()

    @Synchronized
    private fun ensureLoaded(context: Context) {
        if (_messages.value.isNotEmpty()) return
        _messages.value = loadFromPrefs(context)
    }

    private fun loadFromPrefs(context: Context): List<VisitorMessage> {
            val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_RECENT, "[]")
            return runCatching {
                val arr = JSONArray(raw)
                buildList {
                    for (i in 0 until arr.length()) {
                        val item = arr.optJSONObject(i) ?: continue
                        add(VisitorMessage(
                            id = item.optString("id"),
                            viewerId = item.optString("viewer_id"),
                            viewerName = item.optString("viewer_name"),
                            viewerRemark = item.optString("viewer_remark"),
                            kind = item.optString("kind", "private"),
                            direction = item.optString("direction", "viewer"),
                            text = item.optString("text"),
                            at = item.optLong("at"),
                        ))
                }
                }
            }.getOrElse { emptyList() }
        }

    fun add(
        context: Context,
        id: String,
        viewerId: String,
        text: String,
        viewerName: String = "",
        viewerRemark: String = "",
        kind: String = "private",
        direction: String = "viewer",
        at: Long = System.currentTimeMillis(),
    ) {
        if (viewerId.isBlank() || text.isBlank()) return
        val next = listOf(
            VisitorMessage(
                id = id.ifBlank { "${viewerId}_${System.currentTimeMillis()}" },
                viewerId = viewerId,
                viewerName = viewerName,
                viewerRemark = viewerRemark,
                kind = kind,
                direction = direction,
                text = text.take(500),
                at = at,
            )
        ) + recent(context).filterNot { it.id == id }
        save(context, next.sortedByDescending { it.at }.take(MAX_MESSAGES))
    }

    fun upsertAll(context: Context, messages: List<VisitorMessage>) {
        val merged = (messages + recent(context))
            .distinctBy { it.id }
            .sortedByDescending { it.at }
            .take(MAX_MESSAGES)
        save(context, merged)
    }

    fun delete(context: Context, messageId: String) {
        if (messageId.isBlank()) return
        save(context, recent(context).filterNot { it.id == messageId })
    }

    fun deleteViewer(context: Context, viewerId: String) {
        if (viewerId.isBlank()) return
        save(context, recent(context).filterNot { it.viewerId == viewerId })
    }

    fun setRemark(context: Context, viewerId: String, remark: String) {
        if (viewerId.isBlank()) return
        val cleaned = remark.trim().take(500)
        save(context, recent(context).map {
            if (it.viewerId == viewerId) it.copy(viewerRemark = cleaned) else it
        })
    }

    fun recent(context: Context): List<VisitorMessage> {
        ensureLoaded(context)
        return _messages.value
    }
    /** Legacy: reads SharedPreferences directly. Prefer recent() which uses in-memory cache. */
    fun recentFromDisk(context: Context): List<VisitorMessage> {
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
                            viewerName = item.optString("viewer_name"),
                            viewerRemark = item.optString("viewer_remark"),
                            kind = item.optString("kind", "private"),
                            direction = item.optString("direction", "viewer"),
                            text = item.optString("text"),
                            at = item.optLong("at"),
                        )
                    )
                }
            }
        }.getOrElse { emptyList() }
    }

    fun latestServerTimestamp(context: Context): String {
        val latest = _messages.value.maxByOrNull { it.at } ?: run {
            loadFromPrefs(context).maxByOrNull { it.at } ?: return ""
        }
        val withDriftMargin = (latest.at - 5 * 60 * 1000L).coerceAtLeast(0L)
        return java.time.Instant.ofEpochMilli(withDriftMargin).toString()
    }

    fun groupedByViewer(context: Context): List<Pair<String, List<VisitorMessage>>> =
        _messages.value.ifEmpty { loadFromPrefs(context) }
            .groupBy { it.viewerId }
            .mapValues { (_, values) -> values.sortedBy { it.at } }
            .toList()
            .sortedByDescending { (_, values) -> values.maxOfOrNull { it.at } ?: 0L }

    private fun save(context: Context, messages: List<VisitorMessage>) {
        _messages.value = messages
        val arr = JSONArray()
        for (message in messages) {
            arr.put(
                JSONObject()
                    .put("id", message.id)
                    .put("viewer_id", message.viewerId)
                    .put("viewer_name", message.viewerName)
                    .put("viewer_remark", message.viewerRemark)
                    .put("kind", message.kind)
                    .put("direction", message.direction)
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
