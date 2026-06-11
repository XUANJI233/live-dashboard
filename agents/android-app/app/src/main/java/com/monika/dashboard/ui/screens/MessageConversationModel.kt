package com.monika.dashboard.ui.screens

import com.monika.dashboard.data.MessageInboxStore
import com.monika.dashboard.data.VisitorMessage

internal data class MessageConversation(
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

internal data class ConversationDetailActions(
    val onBack: () -> Unit,
    val onOpenRemark: (String, String) -> Unit,
    val onBlock: (String) -> Unit,
    val onSend: (String, String, String) -> Unit,
    val onMessageLongPress: (VisitorMessage) -> Unit,
)

internal fun buildConversations(messages: List<VisitorMessage>): List<MessageConversation> =
    messages
        .groupBy { it.viewerId }
        .map { (viewerId, values) -> conversationOf(viewerId, values) }
        .sortedWith(
            compareBy<MessageConversation> { if (it.isPrivileged) 0 else 1 }
                .thenByDescending { it.latest?.at ?: 0L },
        )

internal fun emptyConversation(viewerId: String): MessageConversation =
    conversationOf(viewerId, emptyList())

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
