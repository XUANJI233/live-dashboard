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
import androidx.compose.runtime.mutableIntStateOf
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
import com.monika.dashboard.realtime.MessageHistorySyncer
import com.monika.dashboard.realtime.MessageSocketManager
import com.monika.dashboard.ui.components.DashboardCard
import com.monika.dashboard.ui.components.DashboardTone
import com.monika.dashboard.ui.components.EmptyState
import com.monika.dashboard.ui.components.InitialBadge
import com.monika.dashboard.ui.components.ScreenHeader
import com.monika.dashboard.ui.components.SectionTitle
import com.monika.dashboard.ui.components.StatusPill
import com.monika.dashboard.ui.theme.TextMuted
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun MessagesScreen(settings: SettingsStore, showHeader: Boolean = true) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var allMessages by remember { mutableStateOf(MessageInboxStore.recent(context)) }
    var selectedViewer by remember { mutableStateOf<String?>(null) }
    var replyText by remember { mutableStateOf("") }
    var detailViewerId by remember { mutableStateOf<String?>(null) }
    var remarkText by remember { mutableStateOf("") }
    var detailMessage by remember { mutableStateOf<VisitorMessage?>(null) }

    val syncMessages: suspend () -> Unit = {
        MessageHistorySyncer.sync(context, settings)
    }

    LaunchedEffect(Unit) {
        MessageInboxStore.messages.collect { allMessages = it }
    }

    LaunchedEffect(Unit) {
        syncMessages()
    }

    LaunchedEffect(Unit) {
        while (true) {
            delay(15_000)
            syncMessages()
        }
    }

    val groups = remember(allMessages) {
        allMessages
            .groupBy { it.viewerId }
            .mapValues { (_, v) -> v.sortedBy { it.at } }
            .toList()
            .sortedByDescending { (_, v) -> v.maxOfOrNull { it.at } ?: 0L }
    }
    var blockTick by remember { mutableIntStateOf(0) }
    val blockedViewers = remember(blockTick) { MessageSocketManager.blockedViewers(context).toList().sorted() }
    val activeViewer = selectedViewer ?: groups.firstOrNull()?.first
    val activeMessages = groups.firstOrNull { it.first == activeViewer }?.second.orEmpty()
    val activeName = activeMessages.visitorLabel()
    val activeRemark = activeMessages.lastOrNull { it.viewerRemark.isNotBlank() }?.viewerRemark.orEmpty()

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
                    title = "私聊",
                    subtitle = "网页访客的一对一消息，公开留言板在独立页面处理。",
                    meta = "${groups.size} 会话",
                )
            }
        }

        if (groups.isEmpty()) {
            item {
                EmptyState(
                    title = "暂无访客消息",
                    body = "收到网页私聊后会在这里出现；实时连接断开时会用 HTTP 历史记录兜底同步。",
                )
            }
        } else {
            item {
                DashboardCard(tone = DashboardTone.Info) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Row(
                            modifier = Modifier.weight(1f),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            InitialBadge(text = "访", tone = DashboardTone.Info)
                            Column {
                                Text(
                                    text = activeRemark.ifBlank { activeName },
                                    style = MaterialTheme.typography.titleMedium,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    text = activeViewer.orEmpty(),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = TextMuted,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                        StatusPill(text = "${activeMessages.size} 条", tone = DashboardTone.Info)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(
                            enabled = activeViewer != null,
                            onClick = {
                                val viewerId = activeViewer ?: return@TextButton
                                detailViewerId = viewerId
                                remarkText = activeRemark
                            },
                        ) {
                            Text("备注")
                        }
                        TextButton(
                            enabled = activeViewer != null,
                            onClick = {
                                val viewerId = activeViewer ?: return@TextButton
                                MessageSocketManager.blockViewer(context, viewerId)
                                scope.launch(Dispatchers.IO) {
                                    syncMessageAction(settings) { client -> client.blockViewer(viewerId) }
                                }
                                blockTick++
                            },
                        ) {
                            Text("拉黑")
                        }
                    }
                }
            }

            item { SectionTitle("消息", meta = "长按消息可删除") }

            items(activeMessages, key = { it.id }) { message ->
                val mine = message.direction == "device"
                DashboardCard(
                    modifier = Modifier
                        .fillMaxWidth()
                        .combinedClickable(
                            onClick = {},
                            onLongClick = { detailMessage = message },
                        ),
                    tone = if (mine) DashboardTone.Good else DashboardTone.Neutral,
                    contentPadding = 12.dp,
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.Top,
                    ) {
                        Row(
                            modifier = Modifier.weight(1f),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            InitialBadge(
                                text = if (mine) "我" else "访",
                                tone = if (mine) DashboardTone.Good else DashboardTone.Neutral,
                            )
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = if (mine) "管理员回复" else message.viewerName.ifBlank { "访客" },
                                    style = MaterialTheme.typography.labelSmall,
                                    color = TextMuted,
                                )
                                Text(text = message.text, style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                        Text(
                            text = formatMessageTime(message.at),
                            style = MaterialTheme.typography.labelSmall,
                            color = TextMuted,
                        )
                    }
                }
            }

            item {
                DashboardCard {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                        OutlinedTextField(
                            value = replyText,
                            onValueChange = { replyText = it.take(500) },
                            modifier = Modifier.weight(1f),
                            singleLine = true,
                            placeholder = { Text("回复当前访客") },
                            shape = RoundedCornerShape(10.dp),
                        )
                        Button(
                            enabled = activeViewer != null && replyText.isNotBlank(),
                            onClick = {
                                val viewerId = activeViewer ?: return@Button
                                val related = activeMessages.lastOrNull()?.id.orEmpty()
                                val text = replyText.trim()
                                replyText = ""
                                scope.launch(Dispatchers.IO) {
                                    syncMessageAction(settings) { client ->
                                        client.replyToMessage(related, viewerId, text)
                                    }
                                    delay(200)
                                    syncMessages()
                                    blockTick++
                                }
                            },
                            shape = RoundedCornerShape(10.dp),
                        ) {
                            Text("发送")
                        }
                    }
                }
            }

            item { SectionTitle("会话", meta = "点按切换，长按详情") }

            items(groups, key = { it.first }) { (viewerId, messages) ->
                val latest = messages.lastOrNull()
                val selected = viewerId == activeViewer
                val name = messages.visitorLabel()
                val remark = messages.lastOrNull { it.viewerRemark.isNotBlank() }?.viewerRemark.orEmpty()
                DashboardCard(
                    modifier = Modifier
                        .fillMaxWidth()
                        .combinedClickable(
                            onClick = { selectedViewer = viewerId },
                            onLongClick = {
                                detailViewerId = viewerId
                                remarkText = remark
                            },
                        ),
                    tone = if (selected) DashboardTone.Info else DashboardTone.Neutral,
                    contentPadding = 12.dp,
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        InitialBadge(text = "访", tone = if (selected) DashboardTone.Info else DashboardTone.Neutral)
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = remark.ifBlank { name },
                                style = MaterialTheme.typography.titleSmall,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                text = latest?.text.orEmpty(),
                                style = MaterialTheme.typography.bodySmall,
                                color = TextMuted,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        StatusPill(text = messages.size.toString(), tone = if (selected) DashboardTone.Info else DashboardTone.Neutral)
                    }
                }
            }
        }

        if (blockedViewers.isNotEmpty()) {
            item { SectionTitle("黑名单") }
            items(blockedViewers, key = { it }) { viewerId ->
                DashboardCard(tone = DashboardTone.Bad, contentPadding = 12.dp) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = viewerId,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.weight(1f),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        TextButton(
                            onClick = {
                                MessageSocketManager.unblockViewer(context, viewerId)
                                scope.launch(Dispatchers.IO) {
                                    syncMessageAction(settings) { client -> client.unblockViewer(viewerId) }
                                }
                                blockTick++
                            },
                        ) {
                            Text("解除")
                        }
                    }
                }
            }
        }

        item { Spacer(modifier = Modifier.height(8.dp)) }
    }

    detailViewerId?.let { viewerId ->
        val messages = groups.firstOrNull { it.first == viewerId }?.second.orEmpty()
        val name = messages.visitorLabel()
        AlertDialog(
            onDismissRequest = { detailViewerId = null },
            title = { Text("访客详情") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("ID: $viewerId", style = MaterialTheme.typography.bodySmall)
                    Text("名称: $name", style = MaterialTheme.typography.bodySmall)
                    OutlinedTextField(
                        value = remarkText,
                        onValueChange = { remarkText = it.take(500) },
                        label = { Text("云同步备注") },
                        singleLine = false,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val cleaned = remarkText.trim()
                        MessageInboxStore.setRemark(context, viewerId, cleaned)
                        scope.launch(Dispatchers.IO) {
                            syncMessageAction(settings) { client -> client.setViewerRemark(viewerId, cleaned) }
                        }
                        blockTick++
                        detailViewerId = null
                    },
                ) {
                    Text("保存备注")
                }
            },
            dismissButton = {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(
                        onClick = {
                            MessageInboxStore.deleteViewer(context, viewerId)
                            if (selectedViewer == viewerId) selectedViewer = null
                            scope.launch(Dispatchers.IO) {
                                syncMessageAction(settings) { client -> client.deleteViewerMessages(viewerId) }
                            }
                            blockTick++
                            detailViewerId = null
                        },
                    ) {
                        Text("删除会话")
                    }
                    TextButton(onClick = { detailViewerId = null }) { Text("关闭") }
                }
            },
        )
    }

    detailMessage?.let { message ->
        AlertDialog(
            onDismissRequest = { detailMessage = null },
            title = { Text("消息详情") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("消息 ID: ${message.id}", style = MaterialTheme.typography.bodySmall)
                    Text("访客 ID: ${message.viewerId}", style = MaterialTheme.typography.bodySmall)
                    Text("类型: ${message.kind} / ${message.direction}", style = MaterialTheme.typography.bodySmall)
                    Text(message.text, style = MaterialTheme.typography.bodyMedium)
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        MessageInboxStore.delete(context, message.id)
                        scope.launch(Dispatchers.IO) {
                            syncMessageAction(settings) { client -> client.deleteMessage(message.id) }
                        }
                        blockTick++
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

suspend fun syncMessageAction(
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

private fun List<VisitorMessage>.visitorLabel(): String =
    lastOrNull { it.viewerName.isNotBlank() }?.viewerName ?: "访客"

private fun formatMessageTime(millis: Long): String =
    if (millis <= 0) "--" else SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(millis))
