package com.monika.dashboard.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.monika.dashboard.data.MessageInboxStore
import com.monika.dashboard.data.SettingsStore
import com.monika.dashboard.data.VisitorMessage
import com.monika.dashboard.network.ReportClient
import com.monika.dashboard.ui.components.DashboardCard
import com.monika.dashboard.ui.components.DashboardTone
import com.monika.dashboard.ui.components.EmptyState
import com.monika.dashboard.ui.components.InitialBadge
import com.monika.dashboard.ui.components.ScreenHeader
import com.monika.dashboard.ui.components.SectionTitle
import com.monika.dashboard.ui.components.StatusPill
import com.monika.dashboard.ui.components.friendlyErrorMessage
import com.monika.dashboard.ui.theme.TextMuted
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.LinkedHashMap

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun BoardScreen(settings: SettingsStore, showHeader: Boolean = true) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var detailMessage by remember { mutableStateOf<VisitorMessage?>(null) }
    var replyText by remember { mutableStateOf("") }
    var publicMessages by remember { mutableStateOf<List<ReportClient.PublicMessage>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var loadError by remember { mutableStateOf<String?>(null) }

    suspend fun loadPublicMessages(recent: Boolean = true) {
        loading = true
        loadError = null
        val freshResult = withContext(Dispatchers.IO) {
            val url = settings.serverUrl.first()
            val token = settings.getToken()
            if (url.isBlank() || token.isNullOrBlank()) {
                Result.success(emptyList())
            } else {
                val client = ReportClient(url, token)
                try {
                    if (recent) {
                        client.fetchPublicMessages()
                    } else {
                        val merged = currentMessageSlots().flatMap { slot ->
                            client.fetchPublicMessages(slot = slot).getOrDefault(emptyList())
                        }
                        Result.success(merged)
                    }
                } finally {
                    client.shutdown()
                }
            }
        }
        freshResult
            .onSuccess { publicMessages = mergePublicMessages(publicMessages, it) }
            .onFailure { loadError = friendlyErrorMessage(it) }
        loading = false
    }

    LaunchedEffect(Unit) {
        var recent = true
        while (true) {
            loadPublicMessages(recent)
            recent = false
            delay(30_000)
        }
    }

    val replyTarget = publicMessages.lastOrNull { it.kind == "public" || it.kind == "public_reply" }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(
            start = 16.dp,
            top = if (showHeader) 16.dp else 8.dp,
            end = 16.dp,
            bottom = 16.dp,
        ),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (showHeader) {
            item {
                ScreenHeader(
                    title = "公开",
                    subtitle = "公开留言板是独立公共流，不绑定到某一个访客私聊。",
                    meta = "${publicMessages.size} 条",
                )
            }
        }

        item {
            DashboardCard {
                SectionTitle("公开回复")
                Text(
                    text = "回复会进入公共留言板，并同步给所有管理员设备。",
                    style = MaterialTheme.typography.bodySmall,
                    color = TextMuted,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    OutlinedTextField(
                        value = replyText,
                        onValueChange = { replyText = it.take(500) },
                        modifier = Modifier.weight(1f),
                        singleLine = true,
                        placeholder = { Text("写一条公开回复") },
                        shape = RoundedCornerShape(10.dp),
                    )
                    Button(
                        enabled = replyText.isNotBlank() && replyTarget != null,
                        onClick = {
                            val text = replyText.trim()
                            val target = replyTarget ?: return@Button
                            replyText = ""
                            scope.launch {
                                withContext(Dispatchers.IO) {
                                    boardWriteAction(settings) { client ->
                                        client.replyToMessage(target.id, "__public__", text)
                                    }
                                }
                                delay(200)
                                loadPublicMessages()
                            }
                        },
                        shape = RoundedCornerShape(10.dp),
                    ) {
                        Text("发送")
                    }
                }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    StatusPill(
                        text = when {
                            loading -> "同步中"
                            loadError != null -> "同步失败"
                            else -> "已加载"
                        },
                        tone = when {
                            loading -> DashboardTone.Info
                            loadError != null -> DashboardTone.Bad
                            else -> DashboardTone.Good
                        },
                    )
                    TextButton(onClick = { scope.launch { loadPublicMessages() } }) {
                        Text("刷新")
                    }
                }
                loadError?.let {
                    Text(text = it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                }
            }
        }

        item { SectionTitle("留言流", meta = "长按可查看详情") }

        if (publicMessages.isEmpty() && !loading) {
            item {
                EmptyState(
                    title = "暂无公开留言",
                    body = "游客在网页公开留言板发言后会出现在这里。",
                )
            }
        } else {
            items(publicMessages, key = { it.id }) { message ->
                val isAdmin = message.kind == "public_reply"
                DashboardCard(
                    modifier = Modifier
                        .fillMaxWidth()
                        .combinedClickable(
                            onClick = {},
                            onLongClick = {
                                detailMessage = VisitorMessage(
                                    id = message.id,
                                    viewerId = message.viewerId,
                                    viewerName = message.viewerName,
                                    viewerRemark = "",
                                    kind = message.kind,
                                    direction = if (isAdmin) "device" else "viewer",
                                    text = message.text,
                                    at = parsePublicTime(message.createdAt),
                                )
                            },
                        ),
                    tone = if (isAdmin) DashboardTone.Good else DashboardTone.Neutral,
                    contentPadding = 12.dp,
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        InitialBadge(
                            text = if (isAdmin) "UP" else "访",
                            tone = if (isAdmin) DashboardTone.Good else DashboardTone.Neutral,
                        )
                        Column(modifier = Modifier.weight(1f)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    text = if (isAdmin) "管理员" else message.viewerName.ifBlank { "访客" },
                                    style = MaterialTheme.typography.labelSmall,
                                    color = TextMuted,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    text = formatPublicTime(message.createdAt),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = TextMuted,
                                )
                            }
                            Text(text = message.text, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            }
        }

        item { Spacer(modifier = Modifier.height(8.dp)) }
    }

    detailMessage?.let { message ->
        AlertDialog(
            onDismissRequest = { detailMessage = null },
            title = { Text("公开留言详情") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("消息 ID: ${message.id}", style = MaterialTheme.typography.bodySmall)
                    Text("访客 ID: ${message.viewerId}", style = MaterialTheme.typography.bodySmall)
                    Text(message.text, style = MaterialTheme.typography.bodyMedium)
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        MessageInboxStore.delete(context, message.id)
                        publicMessages = publicMessages.filterNot { it.id == message.id }
                        scope.launch {
                            withContext(Dispatchers.IO) {
                                boardWriteAction(settings) { client -> client.deleteMessage(message.id) }
                            }
                            delay(200)
                            loadPublicMessages()
                        }
                        detailMessage = null
                    },
                ) {
                    Text("删除")
                }
            },
            dismissButton = {
                TextButton(onClick = { detailMessage = null }) { Text("关闭") }
            },
        )
    }
}

private fun mergePublicMessages(
    current: List<ReportClient.PublicMessage>,
    incoming: List<ReportClient.PublicMessage>,
): List<ReportClient.PublicMessage> {
    val merged = LinkedHashMap<String, ReportClient.PublicMessage>()
    for (message in current) {
        if (message.id.isNotBlank()) merged[message.id] = message
    }
    for (message in incoming) {
        if (message.id.isNotBlank()) merged[message.id] = message
    }
    return merged.values
        .sortedBy { parsePublicTime(it.createdAt) }
        .takeLast(MAX_PUBLIC_MESSAGES)
}

private const val MAX_PUBLIC_MESSAGES = 500

private suspend fun boardWriteAction(
    settings: SettingsStore,
    action: (ReportClient) -> Result<Unit>,
) {
    val url = settings.serverUrl.first()
    val token = settings.getToken()
    if (url.isBlank() || token.isNullOrBlank()) return
    val client = ReportClient(url, token)
    try {
        action(client)
    } finally {
        client.shutdown()
    }
}

private fun currentMessageSlots(slotMinutes: Int = 10): List<String> {
    val now = ZonedDateTime.now(ZoneOffset.UTC)
    return listOf(
        messageSlot(now, slotMinutes),
        messageSlot(now.minusMinutes(slotMinutes.toLong()), slotMinutes),
    ).distinct()
}

private fun messageSlot(time: ZonedDateTime, slotMinutes: Int): String {
    val now = time.withZoneSameInstant(ZoneOffset.UTC)
    val minute = (now.minute / slotMinutes) * slotMinutes
    return "${now.year}${two(now.monthValue)}${two(now.dayOfMonth)}${two(now.hour)}${two(minute)}"
}

private fun two(value: Int): String = value.toString().padStart(2, '0')

private fun parsePublicTime(value: String): Long =
    runCatching { Instant.parse(value).toEpochMilli() }.getOrDefault(0L)

private fun formatPublicTime(value: String): String =
    runCatching {
        Instant.parse(value)
            .atZone(ZoneOffset.systemDefault())
            .format(DateTimeFormatter.ofPattern("MM-dd HH:mm"))
    }.getOrDefault("--")
