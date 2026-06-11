package com.monika.dashboard.ui.screens

import androidx.activity.compose.BackHandler
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
import androidx.compose.material3.AlertDialog
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
import androidx.compose.runtime.saveable.rememberSaveable
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
import com.monika.dashboard.ui.components.ReplyComposer
import com.monika.dashboard.ui.components.ScreenHeader
import com.monika.dashboard.ui.components.SectionTitle
import com.monika.dashboard.ui.components.StatusPill
import com.monika.dashboard.ui.theme.TextMuted
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun MessagesScreen(
    settings: SettingsStore,
    showHeader: Boolean = true,
    initialViewerId: String? = null,
    initialSelectionNonce: Long = 0L,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var allMessages by remember { mutableStateOf(MessageInboxStore.recent(context)) }
    var selectedViewer by rememberSaveable { mutableStateOf<String?>(null) }
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

    LaunchedEffect(initialViewerId, initialSelectionNonce) {
        val target = initialViewerId?.takeIf { it.isNotBlank() }
        if (target != null) selectedViewer = target
    }

    LaunchedEffect(selectedViewer) {
        replyText = ""
    }

    val conversations = remember(allMessages) { buildConversations(allMessages) }
    val activeConversation = conversations.firstOrNull { it.viewerId == selectedViewer }
    var blockTick by remember { mutableIntStateOf(0) }
    val blockedViewers = remember(blockTick) { MessageSocketManager.blockedViewers(context).toList().sorted() }

    if (selectedViewer != null) {
        BackHandler { selectedViewer = null }
        ConversationDetail(
            conversation = activeConversation ?: emptyConversation(selectedViewer.orEmpty()),
            replyText = replyText,
            onReplyTextChange = { replyText = it },
            actions = ConversationDetailActions(
                onBack = { selectedViewer = null },
                onOpenRemark = { viewerId, remark ->
                    detailViewerId = viewerId
                    remarkText = remark
                },
                onBlock = { viewerId ->
                    MessageSocketManager.blockViewer(context, viewerId)
                    scope.launch(Dispatchers.IO) {
                        syncMessageAction(settings) { client -> client.blockViewer(viewerId) }
                    }
                    blockTick++
                },
                onSend = { viewerId, relatedMessageId, text ->
                    replyText = ""
                    scope.launch(Dispatchers.IO) {
                        syncMessageAction(settings) { client ->
                            client.replyToMessage(relatedMessageId, viewerId, text)
                        }
                        delay(200)
                        syncMessages()
                        blockTick++
                    }
                },
                onMessageLongPress = { detailMessage = it },
            ),
        )
    } else {
        ConversationList(
            showHeader = showHeader,
            conversations = conversations,
            blockedViewers = blockedViewers,
            onOpenConversation = { selectedViewer = it },
            onOpenRemark = { viewerId, remark ->
                detailViewerId = viewerId
                remarkText = remark
            },
            onUnblock = { viewerId ->
                MessageSocketManager.unblockViewer(context, viewerId)
                scope.launch(Dispatchers.IO) {
                    syncMessageAction(settings) { client -> client.unblockViewer(viewerId) }
                }
                blockTick++
            },
        )
    }

    detailViewerId?.let { viewerId ->
        val conversation = conversations.firstOrNull { it.viewerId == viewerId } ?: emptyConversation(viewerId)
        AlertDialog(
            onDismissRequest = { detailViewerId = null },
            title = { Text("访客详情") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("ID: $viewerId", style = MaterialTheme.typography.bodySmall)
                    Text("名称: ${conversation.label}", style = MaterialTheme.typography.bodySmall)
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

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ConversationList(
    showHeader: Boolean,
    conversations: List<MessageConversation>,
    blockedViewers: List<String>,
    onOpenConversation: (String) -> Unit,
    onOpenRemark: (String, String) -> Unit,
    onUnblock: (String) -> Unit,
) {
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
                    meta = "${conversations.size} 会话",
                )
            }
        }

        if (conversations.isEmpty()) {
            item {
                EmptyState(
                    title = "暂无访客消息",
                    body = "收到网页私聊后会在这里出现；实时连接断开时会用 HTTP 历史记录兜底同步。",
                )
            }
        } else {
            item { SectionTitle("会话", meta = "点按进入") }
            items(conversations, key = { it.viewerId }) { conversation ->
                ConversationRow(
                    conversation = conversation,
                    onClick = { onOpenConversation(conversation.viewerId) },
                    onLongClick = if (conversation.isPrivileged) {
                        null
                    } else {
                        { onOpenRemark(conversation.viewerId, conversation.remark) }
                    },
                )
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
                        TextButton(onClick = { onUnblock(viewerId) }) {
                            Text("解除")
                        }
                    }
                }
            }
        }

        item { Spacer(modifier = Modifier.height(8.dp)) }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ConversationRow(
    conversation: MessageConversation,
    onClick: () -> Unit,
    onLongClick: (() -> Unit)?,
) {
    val latest = conversation.latest
    val tone = if (conversation.isPrivileged) DashboardTone.Info else DashboardTone.Neutral
    DashboardCard(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = onClick,
                onLongClick = onLongClick,
            ),
        tone = tone,
        contentPadding = 12.dp,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            InitialBadge(text = if (conversation.isPrivileged) "督" else "访", tone = tone)
            Column(modifier = Modifier.weight(1f)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = conversation.displayName,
                        modifier = Modifier.weight(1f),
                        style = MaterialTheme.typography.titleSmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = latest?.at?.let(::formatMessageTimestamp).orEmpty(),
                        style = MaterialTheme.typography.labelSmall,
                        color = TextMuted,
                        maxLines = 1,
                    )
                }
                Text(
                    text = latest?.text.orEmpty(),
                    style = MaterialTheme.typography.bodySmall,
                    color = TextMuted,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            StatusPill(text = conversation.messages.size.toString(), tone = tone)
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ConversationDetail(
    conversation: MessageConversation,
    replyText: String,
    onReplyTextChange: (String) -> Unit,
    actions: ConversationDetailActions,
) {
    val groupedMessages = remember(conversation.messages) {
        conversation.messages.sortedBy { it.at }.groupBy { messageDate(it.at) }
    }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, top = 8.dp, end = 16.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            DashboardCard(tone = if (conversation.isPrivileged) DashboardTone.Info else DashboardTone.Neutral) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TextButton(onClick = actions.onBack) { Text("返回") }
                    InitialBadge(
                        text = if (conversation.isPrivileged) "督" else "访",
                        tone = if (conversation.isPrivileged) DashboardTone.Info else DashboardTone.Neutral,
                    )
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = conversation.displayName,
                            style = MaterialTheme.typography.titleMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = conversation.viewerId,
                            style = MaterialTheme.typography.bodySmall,
                            color = TextMuted,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    StatusPill(
                        text = "${conversation.messages.size} 条",
                        tone = if (conversation.isPrivileged) DashboardTone.Info else DashboardTone.Neutral,
                    )
                }
                if (!conversation.isPrivileged) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(
                            onClick = { actions.onOpenRemark(conversation.viewerId, conversation.remark) },
                        ) {
                            Text("备注")
                        }
                        TextButton(onClick = { actions.onBlock(conversation.viewerId) }) {
                            Text("拉黑")
                        }
                    }
                }
            }
        }

        if (conversation.messages.isEmpty()) {
            item {
                EmptyState(
                    title = "暂无消息",
                    body = "这条会话还没有可显示的本地记录，稍后会自动同步历史消息。",
                )
            }
        } else {
            groupedMessages.forEach { (date, messages) ->
                item(key = "day-$date") {
                    SectionTitle(messageDayLabel(date))
                }
                items(messages, key = { it.id }) { message ->
                    MessageBubble(
                        message = message,
                        isPrivileged = conversation.isPrivileged,
                        onLongClick = { actions.onMessageLongPress(message) },
                    )
                }
            }
        }

        if (!conversation.isPrivileged) {
            item {
                DashboardCard {
                    ReplyComposer(
                        value = replyText,
                        onValueChange = onReplyTextChange,
                        placeholder = "回复当前访客",
                        sendEnabled = replyText.isNotBlank(),
                        onSend = {
                            val text = replyText.trim()
                            if (text.isNotBlank()) {
                                actions.onSend(
                                    conversation.viewerId,
                                    conversation.messages.lastOrNull()?.id.orEmpty(),
                                    text,
                                )
                            }
                        },
                    )
                }
            }
        }

        item { Spacer(modifier = Modifier.height(8.dp)) }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageBubble(
    message: VisitorMessage,
    isPrivileged: Boolean,
    onLongClick: () -> Unit,
) {
    val mine = message.direction == "device"
    val tone = when {
        mine -> DashboardTone.Good
        isPrivileged -> DashboardTone.Info
        else -> DashboardTone.Neutral
    }
    DashboardCard(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = {},
                onLongClick = onLongClick,
            ),
        tone = tone,
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
                    text = when {
                        mine -> "我"
                        isPrivileged -> "督"
                        else -> "访"
                    },
                    tone = tone,
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = when {
                            mine -> "管理员回复"
                            isPrivileged -> "AI 监督"
                            else -> message.viewerName.ifBlank { "访客" }
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = TextMuted,
                    )
                    Text(text = message.text, style = MaterialTheme.typography.bodyMedium)
                }
            }
            Text(
                text = formatMessageTimestamp(message.at),
                style = MaterialTheme.typography.labelSmall,
                color = TextMuted,
            )
        }
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

private data class MessageConversation(
    val viewerId: String,
    val messages: List<VisitorMessage>,
    val latest: VisitorMessage?,
    val label: String,
    val remark: String,
    val isPrivileged: Boolean,
) {
    val displayName: String
        get() = when {
            isPrivileged -> "AI 监督"
            remark.isNotBlank() -> remark
            else -> label
        }
}

private data class ConversationDetailActions(
    val onBack: () -> Unit,
    val onOpenRemark: (String, String) -> Unit,
    val onBlock: (String) -> Unit,
    val onSend: (String, String, String) -> Unit,
    val onMessageLongPress: (VisitorMessage) -> Unit,
)

private fun buildConversations(messages: List<VisitorMessage>): List<MessageConversation> =
    messages
        .groupBy { it.viewerId }
        .map { (viewerId, values) -> conversationOf(viewerId, values) }
        .sortedWith(
            compareBy<MessageConversation> { if (it.isPrivileged) 0 else 1 }
                .thenByDescending { it.latest?.at ?: 0L },
        )

private fun conversationOf(viewerId: String, messages: List<VisitorMessage>): MessageConversation {
    val sorted = messages.sortedBy { it.at }
    val isPrivileged = MessageInboxStore.isPrivilegedViewer(viewerId)
    return MessageConversation(
        viewerId = viewerId,
        messages = sorted,
        latest = sorted.lastOrNull(),
        label = if (isPrivileged) {
            "AI 监督"
        } else {
            sorted.lastOrNull { it.viewerName.isNotBlank() }?.viewerName ?: "访客"
        },
        remark = if (isPrivileged) "" else sorted.lastOrNull { it.viewerRemark.isNotBlank() }?.viewerRemark.orEmpty(),
        isPrivileged = isPrivileged,
    )
}

private fun emptyConversation(viewerId: String): MessageConversation =
    conversationOf(viewerId, emptyList())

private fun messageDate(millis: Long): LocalDate =
    if (millis <= 0L) {
        LocalDate.of(1970, 1, 1)
    } else {
        Instant.ofEpochMilli(millis).atZone(ZoneId.systemDefault()).toLocalDate()
    }

private fun messageDayLabel(date: LocalDate): String {
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

private fun formatMessageTimestamp(millis: Long): String {
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
