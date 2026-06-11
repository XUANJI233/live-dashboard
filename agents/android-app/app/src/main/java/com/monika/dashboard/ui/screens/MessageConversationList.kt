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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.monika.dashboard.ui.components.DashboardCard
import com.monika.dashboard.ui.components.DashboardTone
import com.monika.dashboard.ui.components.EmptyState
import com.monika.dashboard.ui.components.InitialBadge
import com.monika.dashboard.ui.components.ScreenHeader
import com.monika.dashboard.ui.components.SectionTitle
import com.monika.dashboard.ui.components.StatusPill
import com.monika.dashboard.ui.theme.TextMuted

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun ConversationList(
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
