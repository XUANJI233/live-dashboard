package com.monika.dashboard.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

data class PendingReport(
    val id: String,
    val body: String,
    val createdAt: Long,
    val attempts: Int,
    val lastError: String,
)

object PendingReportStore {
    private const val PREFS = "pending_reports"
    private const val KEY_ITEMS = "items"
    private const val MAX_ITEMS = 50
    private const val MAX_BODY_BYTES = 24 * 1024

    fun enqueue(context: Context, body: String, error: String = ""): PendingReport? = synchronized(this) {
        val safeBody = body.trim()
        if (safeBody.isBlank() || safeBody.toByteArray(Charsets.UTF_8).size > MAX_BODY_BYTES) return null
        val item = PendingReport(
            id = UUID.randomUUID().toString(),
            body = safeBody,
            createdAt = System.currentTimeMillis(),
            attempts = 0,
            lastError = error.take(160),
        )
        val items = readAllLocked(context).toMutableList()
        items.add(item)
        writeAllLocked(context, items.takeLast(MAX_ITEMS))
        item
    }

    fun peek(context: Context, limit: Int = 8): List<PendingReport> = synchronized(this) {
        readAllLocked(context).take(limit.coerceIn(1, MAX_ITEMS))
    }

    fun remove(context: Context, id: String) = synchronized(this) {
        writeAllLocked(context, readAllLocked(context).filterNot { it.id == id })
    }

    fun markAttempt(context: Context, id: String, error: String) = synchronized(this) {
        writeAllLocked(
            context,
            readAllLocked(context).map {
                if (it.id == id) it.copy(attempts = it.attempts + 1, lastError = error.take(160)) else it
            },
        )
    }

    fun count(context: Context): Int = synchronized(this) {
        readAllLocked(context).size
    }

    fun clearForTest(context: Context) = synchronized(this) {
        prefs(context).edit().clear().commit()
    }

    private fun readAllLocked(context: Context): List<PendingReport> {
        val raw = prefs(context).getString(KEY_ITEMS, "[]").orEmpty()
        return runCatching {
            val arr = JSONArray(raw)
            buildList {
                for (i in 0 until arr.length()) {
                    val obj = arr.optJSONObject(i) ?: continue
                    val id = obj.optString("id").takeIf { it.isNotBlank() } ?: continue
                    val body = obj.optString("body").takeIf { it.isNotBlank() } ?: continue
                    add(
                        PendingReport(
                            id = id,
                            body = body,
                            createdAt = obj.optLong("created_at", System.currentTimeMillis()),
                            attempts = obj.optInt("attempts", 0).coerceAtLeast(0),
                            lastError = obj.optString("last_error"),
                        ),
                    )
                }
            }
        }.getOrDefault(emptyList())
    }

    private fun writeAllLocked(context: Context, items: List<PendingReport>) {
        val arr = JSONArray()
        for (item in items) {
            arr.put(
                JSONObject()
                    .put("id", item.id)
                    .put("body", item.body)
                    .put("created_at", item.createdAt)
                    .put("attempts", item.attempts)
                    .put("last_error", item.lastError),
            )
        }
        prefs(context).edit().putString(KEY_ITEMS, arr.toString()).commit()
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
