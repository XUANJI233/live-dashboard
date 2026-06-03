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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.LinkedHashSet

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun BoardScreen(settings: SettingsStore) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var tick by remember { mutableIntStateOf(0) }
    var detailMessage by remember { mutableStateOf<com.monika.dashboard.data.VisitorMessage?>(null) }
    var replyText by remember { mutableStateOf("") }
    var publicMessages by remember { mutableStateOf<List<ReportClient.PublicMessage>>(emptyList()) }

    LaunchedEffect(Unit) {
        while (true) {
            val url = settings.serverUrl.first()
            val token = withContext(Dispatchers.IO) { settings.getToken() }
            if (url.isNotBlank() && !token.isNullOrBlank()) {
                withContext(Dispatchers.IO) {
                    val client = ReportClient(url, token)
                    try {
                        val fresh = client.fetchPublicMessages().getOrDefault(emptyList())
                        val existing = LinkedHashSet(publicMessages)
                        existing.addAll(fresh)
                        publicMessages = existing.toList()
                    } finally { client.shutdown() }
                }
            }
            tick++
            delay(15_000)
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Text("公开留言板", style = MaterialTheme.typography.titleLarge)

        Column(modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (publicMessages.isEmpty()) Text("暂无公开留言", style = MaterialTheme.typography.bodyMedium)
            publicMessages.forEach { message ->
                val isAdmin = message.kind == "public_reply"
                Surface(
                    modifier = Modifier.fillMaxWidth().combinedClickable(
                        onClick = {},
                        onLongClick = {
                            detailMessage = com.monika.dashboard.data.VisitorMessage(
                                id = message.id, viewerId = message.viewerId,
                                viewerName = message.viewerName, viewerRemark = "",
                                kind = message.kind, direction = if (isAdmin) "device" else "viewer",
                                text = message.text, at = 0L,
                            )
                        }
                    ),
                    shape = RoundedCornerShape(8.dp),
                    color = if (isAdmin) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text(
                            text = if (isAdmin) "up" else message.viewerName.ifBlank { "游客" },
                            style = MaterialTheme.typography.labelLarge,
                            color = if (isAdmin) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface
                        )
                        Text(message.text, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }

        // Reply input
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            OutlinedTextField(
                value = replyText, onValueChange = { replyText = it.take(500) },
                modifier = Modifier.weight(1f), singleLine = true,
                placeholder = { Text("公开回复") }
            )
            Button(enabled = replyText.isNotBlank(), onClick = {
                val text = replyText.trim()
                val lastPub = publicMessages.lastOrNull()
                val msgId = lastPub?.id ?: ""
                val vId = lastPub?.viewerId?.ifBlank { "__public__" } ?: "__public__"
                replyText = ""
                scope.launch(Dispatchers.IO) {
                    syncMessageAction(settings) { client -> client.replyToMessage(msgId, vId, text) }
                    delay(200)
                    tick++
                }
            }) { Text("发送") }
        }
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
