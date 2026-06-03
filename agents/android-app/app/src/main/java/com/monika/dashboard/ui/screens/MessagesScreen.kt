package com.monika.dashboard.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.monika.dashboard.data.MessageInboxStore
import com.monika.dashboard.data.SettingsStore
import com.monika.dashboard.network.ReportClient
import com.monika.dashboard.realtime.MessageSocketManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun MessagesScreen(settings: SettingsStore) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var tick by remember { mutableIntStateOf(0) }
    var selectedViewer by remember { mutableStateOf<String?>(null) }
    var replyText by remember { mutableStateOf("") }
    var detailViewerId by remember { mutableStateOf<String?>(null) }
    var remarkText by remember { mutableStateOf("") }
    var detailMessage by remember { mutableStateOf<com.monika.dashboard.data.VisitorMessage?>(null) }

    val syncMessages: suspend () -> Unit = {
        val url = settings.serverUrl.first()
        val token = withContext(Dispatchers.IO) { settings.getToken() }
        if (url.isNotBlank() && !token.isNullOrBlank()) {
            withContext(Dispatchers.IO) {
                val client = ReportClient(url, token)
                try {
                    val latest = MessageInboxStore.latestServerTimestamp(context)
                    client.fetchMessageHistory(latest.takeIf { it.isNotBlank() }).getOrNull()?.let {
                        MessageInboxStore.upsertAll(context, it)
                    }
                } finally {
                    client.shutdown()
                }
            }
        }
    }

    LaunchedEffect(Unit) {
        while (true) {
            syncMessages()
            tick++
            delay(10_000)
        }
    }

    val groups = remember(tick) { MessageInboxStore.groupedByViewer(context) }
    val blockedViewers = remember(tick) { MessageSocketManager.blockedViewers(context).toList().sorted() }
    val activeViewer = selectedViewer ?: groups.firstOrNull()?.first
    val activeMessages = groups.firstOrNull { it.first == activeViewer }?.second.orEmpty()

    Row(
        modifier = Modifier.fillMaxSize().padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Column(
            modifier = Modifier.weight(0.42f).fillMaxHeight().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Text("会话", style = MaterialTheme.typography.titleMedium)
            if (groups.isEmpty()) {
                Text("暂无访客消息", style = MaterialTheme.typography.bodySmall)
            }
            groups.forEach { (viewerId, messages) ->
                val latest = messages.lastOrNull()
                val name = messages.lastOrNull { it.viewerName.isNotBlank() }?.viewerName ?: "游客"
                val remark = messages.lastOrNull { it.viewerRemark.isNotBlank() }?.viewerRemark.orEmpty()
                Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = if (viewerId == activeViewer) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                    modifier = Modifier.fillMaxWidth().combinedClickable(
                        onClick = { selectedViewer = viewerId },
                        onLongClick = {
                            detailViewerId = viewerId
                            remarkText = remark
                        }
                    )
                ) {
                    Column(modifier = Modifier.padding(10.dp)) {
                        Text(remark.ifBlank { name }, style = MaterialTheme.typography.labelLarge)
                        if (remark.isNotBlank() && name != "游客") {
                            Text(name, style = MaterialTheme.typography.labelSmall)
                        }
                        Text(latest?.text.orEmpty(), style = MaterialTheme.typography.bodySmall, maxLines = 2)
                    }
                }
            }
            if (blockedViewers.isNotEmpty()) {
                Spacer(modifier = Modifier.height(8.dp))
                Text("黑名单", style = MaterialTheme.typography.titleSmall)
                blockedViewers.forEach { viewerId ->
                    Surface(
                        shape = RoundedCornerShape(8.dp),
                        color = MaterialTheme.colorScheme.errorContainer,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Row(
                            modifier = Modifier.padding(10.dp),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Text(viewerId, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                            TextButton(onClick = {
                                MessageSocketManager.unblockViewer(context, viewerId)
                                scope.launch(Dispatchers.IO) {
                                    syncMessageAction(settings) { client -> client.unblockViewer(viewerId) }
                                }
                                tick++
                            }) { Text("解除") }
                        }
                    }
                }
            }
        }

        Column(
            modifier = Modifier.weight(0.58f).fillMaxHeight(),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Text("消息", style = MaterialTheme.typography.titleMedium)
            Column(
                modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                activeMessages.forEach { message ->
                    val mine = message.direction == "device"
                    Surface(
                        shape = RoundedCornerShape(8.dp),
                        color = if (mine) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                        modifier = Modifier.fillMaxWidth().combinedClickable(
                            onClick = {},
                            onLongClick = { detailMessage = message }
                        )
                    ) {
                        Column(modifier = Modifier.padding(10.dp)) {
                            Text(
                                text = "${if (mine) "我" else message.viewerName.ifBlank { "游客" }} · ${message.kind}",
                                style = MaterialTheme.typography.labelSmall
                            )
                            Text(message.text, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                OutlinedTextField(
                    value = replyText,
                    onValueChange = { replyText = it.take(500) },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    placeholder = { Text("回复访客") }
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
                            tick++
                        }
                    }
                ) { Text("发送") }
            }
            TextButton(
                enabled = activeViewer != null,
                onClick = {
                    val viewerId = activeViewer ?: return@TextButton
                    MessageSocketManager.blockViewer(context, viewerId)
                    scope.launch(Dispatchers.IO) {
                        syncMessageAction(settings) { client -> client.blockViewer(viewerId) }
                    }
                    tick++
                }
            ) { Text("拉黑此访客") }
        }
    }

    detailViewerId?.let { viewerId ->
        val messages = groups.firstOrNull { it.first == viewerId }?.second.orEmpty()
        val name = messages.lastOrNull { it.viewerName.isNotBlank() }?.viewerName ?: "游客"
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
                TextButton(onClick = {
                    val cleaned = remarkText.trim()
                    MessageInboxStore.setRemark(context, viewerId, cleaned)
                    scope.launch(Dispatchers.IO) {
                        syncMessageAction(settings) { client -> client.setViewerRemark(viewerId, cleaned) }
                    }
                    tick++
                    detailViewerId = null
                }) { Text("保存备注") }
            },
            dismissButton = {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = {
                        MessageInboxStore.deleteViewer(context, viewerId)
                        if (selectedViewer == viewerId) selectedViewer = null
                        scope.launch(Dispatchers.IO) {
                            syncMessageAction(settings) { client -> client.deleteViewerMessages(viewerId) }
                        }
                        tick++
                        detailViewerId = null
                    }) { Text("删除会话") }
                    TextButton(onClick = { detailViewerId = null }) { Text("关闭") }
                }
            }
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
                TextButton(onClick = {
                    MessageInboxStore.delete(context, message.id)
                    scope.launch(Dispatchers.IO) {
                        syncMessageAction(settings) { client -> client.deleteMessage(message.id) }
                    }
                    tick++
                    detailMessage = null
                }) { Text("删除") }
            },
            dismissButton = {
                TextButton(onClick = { detailMessage = null }) { Text("关闭") }
            }
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
