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

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun BoardScreen(settings: SettingsStore) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var tick by remember { mutableIntStateOf(0) }
    var detailMessage by remember { mutableStateOf<com.monika.dashboard.data.VisitorMessage?>(null) }

    LaunchedEffect(Unit) {
        while (true) {
            val url = settings.serverUrl.first()
            val token = withContext(Dispatchers.IO) { settings.getToken() }
            if (url.isNotBlank() && !token.isNullOrBlank()) {
                withContext(Dispatchers.IO) {
                    val client = ReportClient(url, token)
                    try {
                        val latest = MessageInboxStore.latestServerTimestamp(context)
                        client.fetchMessageHistory(latest.takeIf { it.isNotBlank() })
                            .getOrNull()
                            ?.let { MessageInboxStore.upsertAll(context, it) }
                    } finally {
                        client.shutdown()
                    }
                }
            }
            tick++
            delay(15_000)
        }
    }

    val publicMessages = remember(tick) {
        MessageInboxStore.recent(context)
            .filter { it.kind == "public" && it.direction == "viewer" }
            .sortedByDescending { it.at }
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Text("公开留言板", style = MaterialTheme.typography.titleLarge)
        if (publicMessages.isEmpty()) {
            Text("暂无公开留言", style = MaterialTheme.typography.bodyMedium)
        }
        publicMessages.forEach { message ->
            Surface(
                modifier = Modifier.fillMaxWidth().combinedClickable(
                    onClick = {},
                    onLongClick = { detailMessage = message }
                ),
                shape = RoundedCornerShape(8.dp),
                color = MaterialTheme.colorScheme.surfaceVariant
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(
                        text = message.viewerRemark.ifBlank { message.viewerName.ifBlank { "游客" } },
                        style = MaterialTheme.typography.labelLarge
                    )
                    if (message.viewerRemark.isNotBlank() && message.viewerName.isNotBlank()) {
                        Text(message.viewerName, style = MaterialTheme.typography.labelSmall)
                    }
                    Text(message.text, style = MaterialTheme.typography.bodyMedium)
                }
            }
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
