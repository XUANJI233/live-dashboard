package com.monika.dashboard.network

import org.json.JSONArray
import org.json.JSONObject

internal fun parseSummaryPlan(arr: JSONArray?): List<ReportClient.SummaryPlanDay> {
    val byWeekday = mutableMapOf<Int, ReportClient.SummaryPlanDay>()
    if (arr != null) {
        for (i in 0 until arr.length()) {
            val item = arr.optJSONObject(i) ?: continue
            val weekday = item.optInt("weekday", 0).coerceIn(0, 7)
            if (weekday == 0) continue
            byWeekday[weekday] = ReportClient.SummaryPlanDay(
                weekday = weekday,
                target = item.optString("target", ""),
                plannedRest = false,
            )
        }
    }
    return (1..7).map { weekday ->
        byWeekday[weekday] ?: ReportClient.SummaryPlanDay(weekday, "", false)
    }
}

internal fun parseSupervisionRules(json: JSONObject?): SupervisionRules {
    if (json == null) return SupervisionRules.empty()
    return SupervisionRules(
        whitelistAppRegex = parseStringArray(json.optJSONArray("whitelist_app_regex")),
        blacklistAppRegex = parseStringArray(json.optJSONArray("blacklist_app_regex")),
        riskAppRegex = parseStringArray(json.optJSONArray("risk_app_regex")),
        targetAppRegex = parseStringArray(json.optJSONArray("target_app_regex")),
        reason = json.optString("reason").take(180),
    )
}

internal fun parseControllerHealth(json: JSONObject?): ReportClient.ControllerHealth? {
    if (json == null) return null
    return ReportClient.ControllerHealth(
        hermesEnabled = json.optBoolean("hermes_enabled", false),
        paused = json.optBoolean("paused", false),
        lastAckAt = json.optNullableString("last_ack_at"),
        lastFailureAt = json.optNullableString("last_failure_at"),
        lastError = json.optString("last_error").take(80),
        pendingCount = json.optInt("pending_count", 0).coerceAtLeast(0),
        deadLast24h = json.optInt("dead_last_24h", 0).coerceAtLeast(0),
        unreachable = json.optBoolean("unreachable", false),
    )
}

private fun JSONObject.optNullableString(key: String): String? =
    optString(key).takeIf { value -> value.isNotBlank() && value != "null" }

private fun parseStringArray(arr: JSONArray?): List<String> {
    if (arr == null) return emptyList()
    return buildList {
        for (i in 0 until arr.length()) {
            val value = arr.optString(i).trim().take(120)
            if (value.isNotBlank() && !contains(value)) add(value)
            if (size >= 12) break
        }
    }
}
