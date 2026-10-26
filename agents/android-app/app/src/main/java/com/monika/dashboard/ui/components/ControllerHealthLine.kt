package com.monika.dashboard.ui.components

import androidx.compose.runtime.Composable
import com.monika.dashboard.network.ReportClient
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * One status line for the external supervision controller (Hermes): paused, unreachable,
 * or when it last confirmed an event. Hidden when Hermes is not the controller.
 */
@Composable
fun ControllerHealthLine(health: ReportClient.ControllerHealth?) {
    if (health == null || !health.hermesEnabled) return
    val (text, tone) = controllerHealthStatus(health)
    StatusBlock(text = text, tone = tone)
}

internal fun controllerHealthStatus(health: ReportClient.ControllerHealth): Pair<String, DashboardTone> {
    val backlog = if (health.pendingCount > 0) "，${health.pendingCount} 条事件待送达" else ""
    return when {
        health.paused ->
            "监督助手已暂停：不会主动唤醒它，手机上的限制照常生效。" to DashboardTone.Neutral
        health.unreachable -> {
            val since = health.lastAckAt?.let { "上次确认 ${shortTime(it)}" } ?: "从未确认"
            val error = health.lastError.takeIf { it.isNotBlank() }?.let { "（$it）" }.orEmpty()
            "监督助手联系不上$error：$since$backlog。" to DashboardTone.Warn
        }
        health.lastAckAt != null ->
            "监督助手在线：最近确认 ${shortTime(health.lastAckAt)}$backlog。" to DashboardTone.Good
        else -> "监督助手还没有确认过事件$backlog。" to DashboardTone.Neutral
    }
}

private fun shortTime(value: String): String =
    runCatching {
        val local = Instant.parse(value).atZone(ZoneId.systemDefault())
        val pattern = if (local.toLocalDate() == LocalDate.now()) "HH:mm" else "MM-dd HH:mm"
        local.format(DateTimeFormatter.ofPattern(pattern))
    }.getOrDefault(value.take(16))
