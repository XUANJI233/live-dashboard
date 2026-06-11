package com.monika.dashboard.ui.screens

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

internal fun messageDate(millis: Long): LocalDate =
    if (millis <= 0L) {
        LocalDate.of(1970, 1, 1)
    } else {
        Instant.ofEpochMilli(millis).atZone(ZoneId.systemDefault()).toLocalDate()
    }

internal fun messageDayLabel(date: LocalDate): String {
    val today = LocalDate.now()
    return when (date) {
        today -> "今天"
        today.minusDays(1) -> "昨天"
        else -> date.format(
            DateTimeFormatter.ofPattern(
                if (date.year == today.year) "M月d日" else "yyyy年M月d日",
            ),
        )
    }
}

internal fun formatMessageTimestamp(millis: Long): String {
    if (millis <= 0L) return "--"
    val time = Instant.ofEpochMilli(millis).atZone(ZoneId.systemDefault()).toLocalDateTime()
    val today = LocalDate.now()
    val pattern = when {
        time.toLocalDate() == today -> "HH:mm"
        time.year == today.year -> "MM-dd HH:mm"
        else -> "yyyy-MM-dd HH:mm"
    }
    return time.format(DateTimeFormatter.ofPattern(pattern))
}
