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
import java.time.Instant
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.util.LinkedHashMap

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun BoardScreen(settings: SettingsStore) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var tick by remember { mutableIntStateOf(0) }
    var detailMessage by remember { mutableStateOf<com.monika.dashboard.data.VisitorMessage?>(null) }
    var replyText by remember { mutableStateOf("") }
    var publicMessages by remember { mutableStateOf<List<ReportClient.PublicMessage>>(emptyList()) }

    suspend fun loadPublicMessages(recent: Boolean = true) {
        val fresh = withContext(Dispatchers.IO) {
            val url = settings.serverUrl.first()
            val token = settings.getToken()
            if (url.isBlank() || token.isNullOrBlank()) {
                emptyList()
            } else {
                val client = ReportClient(url, token)
                try {
                    if (recent) {
                        client.fetchPublicMessages().getOrDefault(emptyList())
                    } else {
                        currentMessageSlots().flatMap { slot ->
                            client.fetchPublicMessages(slot = slot).getOrDefault(emptyList())
                        }
                    }
                } finally {
                    client.shutdown()
                }
            }
        }
        publicMessages = mergePublicMessages(publicMessages, fresh)
    }

    LaunchedEffect(Unit) {
        var recent = true
        while (true) {
            loadPublicMessages(recent)
            recent = false
            tick++
            delay(30_000)
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
            val replyTarget = publicMessages.lastOrNull { it.kind == "public" || it.kind == "public_reply" }
            Button(enabled = replyText.isNotBlank() && replyTarget != null, onClick = {
                val text = replyText.trim()
                val target = replyTarget ?: return@Button
                val msgId = target.id
                replyText = ""
                scope.launch {
                    withContext(Dispatchers.IO) {
                        boardWriteAction(settings) { client -> client.replyToMessage(msgId, "__public__", text) }
                    }
                    delay(200)
                    loadPublicMessages()
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
                    publicMessages = publicMessages.filterNot { it.id == message.id }
                    scope.launch {
                        withContext(Dispatchers.IO) {
                               boardWriteAction(settings) { client -> client.deleteMessage(message.id) }
                        }
                        delay(200)
                        loadPublicMessages()
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
        .sortedBy { runCatching { Instant.parse(it.createdAt).toEpochMilli() }.getOrDefault(0L) }
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
