package com.monika.dashboard.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.monika.dashboard.data.SettingsStore
import com.monika.dashboard.network.ReportClient
import com.monika.dashboard.ui.components.DashboardCard
import com.monika.dashboard.ui.components.DashboardTone
import com.monika.dashboard.ui.components.EmptyState
import com.monika.dashboard.ui.components.InitialBadge
import com.monika.dashboard.ui.components.ScreenHeader
import com.monika.dashboard.ui.components.SectionTitle
import com.monika.dashboard.ui.components.StatusPill
import com.monika.dashboard.ui.theme.TextMuted
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext

@Composable
fun OverviewScreen(settings: SettingsStore) {
    val today = remember { LocalDate.now() }
    var selectedDate by rememberSaveable { mutableStateOf(today.toString()) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var dailySummary by remember { mutableStateOf<ReportClient.DailySummary?>(null) }
    var timeline by remember { mutableStateOf<ReportClient.TimelineResponse?>(null) }

    LaunchedEffect(selectedDate) {
        loading = true
        error = null
        dailySummary = null
        timeline = null
        val result = withContext(Dispatchers.IO) {
            val url = settings.serverUrl.first()
            val token = settings.getToken()
            if (url.isBlank() || token.isNullOrBlank()) {
                Result.failure(IllegalStateException("请先在设置中配置服务器和 Token"))
            } else {
                val client = ReportClient(url, token)
                try {
                    val summaryResult = client.fetchDailySummary(selectedDate)
                    val timelineResult = client.fetchTimeline(selectedDate)
                    summaryResult.fold(
                        onSuccess = { summary ->
                            timelineResult.map { timelineResponse -> summary to timelineResponse }
                        },
                        onFailure = { failure -> Result.failure(failure) },
                    )
                } finally {
                    client.shutdown()
                }
            }
        }
        result
            .onSuccess { (summary, timelineResponse) ->
                dailySummary = summary
                timeline = timelineResponse
            }
            .onFailure { error = it.message ?: it.javaClass.simpleName }
        loading = false
    }

    val days = remember(today) {
        (0L..6L).map { offset -> today.minusDays(offset) }
    }
    val segments = timeline?.segments.orEmpty()
    val appUsage = remember(segments) { aggregateUsage(segments) }
    val totalSeconds = remember(appUsage) { appUsage.sumOf { it.durationSeconds } }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, top = 8.dp, end = 16.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            ScreenHeader(
                title = "概览",
                subtitle = "AI 日总结、日历和当天应用时长。",
                meta = if (loading) "同步中" else selectedDate,
            )
        }

        item {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(days, key = { it.toString() }) { day ->
                    val selected = day.toString() == selectedDate
                    FilterChip(
                        selected = selected,
                        onClick = { selectedDate = day.toString() },
                        label = {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Text(
                                    text = day.format(DateTimeFormatter.ofPattern("MM/dd")),
                                    style = MaterialTheme.typography.labelSmall,
                                )
                                Text(
                                    text = dayLabel(day, today),
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                        },
                    )
                }
            }
        }

        item {
            DashboardCard(tone = DashboardTone.Info) {
                SectionTitle(
                    title = "AI 日总结",
                    meta = dailySummary?.generatedAt?.let { "生成 ${formatClock(it)}" },
                )
                Text(
                    text = dailySummary?.summary
                        ?: "服务端还没有生成这天的 AI 总结；配置 AI_API_URL / AI_API_KEY 后会自动生成。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }

        if (error != null) {
            item {
                DashboardCard(tone = DashboardTone.Bad) {
                    SectionTitle("同步失败")
                    Text(text = error.orEmpty(), style = MaterialTheme.typography.bodySmall, color = TextMuted)
                }
            }
        }

        item {
            SectionTitle(
                title = "当天使用",
                meta = formatDuration(totalSeconds),
            )
        }

        if (appUsage.isEmpty() && !loading) {
            item {
                EmptyState(
                    title = "这天还没有时间线",
                    body = "设备上报后会在这里显示每天用了什么、各用了多久。",
                )
            }
        } else {
            items(appUsage.take(8), key = { "${it.appName}:${it.deviceName}" }) { item ->
                UsageRow(item)
            }
        }

        if (segments.isNotEmpty()) {
            item {
                SectionTitle("最近记录", meta = "${segments.size} 段")
            }
            items(segments.sortedByDescending { it.startedAt }.take(12), key = { "${it.deviceId}:${it.startedAt}:${it.appName}" }) { segment ->
                TimelineRow(segment)
            }
        }

        item { Spacer(modifier = Modifier.height(8.dp)) }
    }
}

private data class UsageItem(
    val appName: String,
    val deviceName: String,
    val durationSeconds: Int,
)

private fun aggregateUsage(segments: List<ReportClient.TimelineSegment>): List<UsageItem> =
    segments
        .filter { it.durationSeconds > 0 }
        .groupBy { Pair(it.appName.ifBlank { it.appId.ifBlank { "未知应用" } }, it.deviceName.ifBlank { it.deviceId }) }
        .map { (key, values) ->
            UsageItem(
                appName = key.first,
                deviceName = key.second,
                durationSeconds = values.sumOf { it.durationSeconds },
            )
        }
        .sortedByDescending { it.durationSeconds }

@Composable
private fun UsageRow(item: UsageItem) {
    DashboardCard(contentPadding = 12.dp) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            InitialBadge(text = item.appName.take(2), tone = DashboardTone.Info)
            Column(modifier = Modifier.weight(1f)) {
                Text(text = item.appName, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(text = item.deviceName, style = MaterialTheme.typography.bodySmall, color = TextMuted)
            }
            StatusPill(text = formatDuration(item.durationSeconds), tone = DashboardTone.Neutral)
        }
    }
}

@Composable
private fun TimelineRow(segment: ReportClient.TimelineSegment) {
    DashboardCard(contentPadding = 12.dp) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            InitialBadge(text = segment.appName.take(2), tone = DashboardTone.Neutral)
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(text = segment.appName.ifBlank { "未知应用" }, style = MaterialTheme.typography.titleSmall)
                    Text(
                        text = formatDuration(segment.durationSeconds),
                        style = MaterialTheme.typography.labelSmall,
                        color = TextMuted,
                    )
                }
                if (segment.displayTitle.isNotBlank()) {
                    Text(
                        text = segment.displayTitle,
                        style = MaterialTheme.typography.bodySmall,
                        color = TextMuted,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Text(
                    text = "${formatClock(segment.startedAt)} - ${segment.endedAt?.let { formatClock(it) } ?: "现在"} · ${segment.deviceName}",
                    style = MaterialTheme.typography.labelSmall,
                    color = TextMuted,
                )
            }
        }
    }
}

private fun dayLabel(day: LocalDate, today: LocalDate): String =
    when (day) {
        today -> "今天"
        today.minusDays(1) -> "昨天"
        else -> day.dayOfWeek.getDisplayName(java.time.format.TextStyle.SHORT, Locale.CHINA)
    }

private fun formatDuration(seconds: Int): String {
    val safe = seconds.coerceAtLeast(0)
    if (safe == 0) return "0 分"
    val minutes = (safe + 59) / 60
    if (minutes < 60) return "${minutes} 分"
    val hours = minutes / 60
    val rest = minutes % 60
    return if (rest == 0) "${hours} 小时" else "${hours} 小时 ${rest} 分"
}

private fun formatClock(value: String): String =
    runCatching {
        Instant.parse(value)
            .atZone(ZoneId.systemDefault())
            .format(DateTimeFormatter.ofPattern("HH:mm"))
    }.getOrDefault("--:--")
