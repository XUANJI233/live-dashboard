package com.monika.dashboard.realtime

import android.content.Context
import com.monika.dashboard.data.MessageInboxStore
import com.monika.dashboard.data.SettingsStore
import com.monika.dashboard.network.ReportClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext

object MessageHistorySyncer {
    suspend fun sync(context: Context, settings: SettingsStore): Int = withContext(Dispatchers.IO) {
        val url = settings.serverUrl.first()
        val token = settings.getToken()
        if (url.isBlank() || token.isNullOrBlank()) return@withContext 0

        val appContext = context.applicationContext
        val client = ReportClient(url, token)
        try {
            val latest = MessageInboxStore.latestServerTimestamp(appContext)
            val since = latest.takeIf { it.isNotBlank() }
            val messages = client.fetchMessageHistory(since).getOrNull().orEmpty()
            if (messages.isNotEmpty()) {
                MessageInboxStore.upsertAll(appContext, messages)
            }
            messages.size
        } finally {
            client.shutdown()
        }
    }
}
