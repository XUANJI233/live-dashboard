package com.monika.dashboard.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.monika.dashboard.data.MessageInboxStore
import com.monika.dashboard.data.SettingsStore
import com.monika.dashboard.data.VisitorMessage
import com.monika.dashboard.network.ReportClient
import com.monika.dashboard.realtime.MessageHistorySyncer
import com.monika.dashboard.realtime.MessageSocketManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

@Composable
fun MessagesScreen(
    settings: SettingsStore,
    showHeader: Boolean = true,
    initialViewerId: String? = null,
    initialSelectionNonce: Long = 0L,
    onInitialViewerConsumed: (Long) -> Unit = {},
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
        if (target != null) {
            selectedViewer = target
            if (initialSelectionNonce != 0L) onInitialViewerConsumed(initialSelectionNonce)
        }
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

private suspend fun syncMessageAction(
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
