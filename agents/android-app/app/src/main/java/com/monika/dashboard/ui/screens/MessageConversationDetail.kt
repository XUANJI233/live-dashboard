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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.monika.dashboard.data.VisitorMessage
import com.monika.dashboard.ui.components.DashboardCard
import com.monika.dashboard.ui.components.DashboardTone
import com.monika.dashboard.ui.components.EmptyState
import com.monika.dashboard.ui.components.InitialBadge
import com.monika.dashboard.ui.components.ReplyComposer
import com.monika.dashboard.ui.components.SectionTitle
import com.monika.dashboard.ui.components.StatusPill
import com.monika.dashboard.ui.theme.TextMuted

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun ConversationDetail(
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
