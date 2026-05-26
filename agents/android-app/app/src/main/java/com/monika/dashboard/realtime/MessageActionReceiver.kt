package com.monika.dashboard.realtime

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.widget.Toast
import com.monika.dashboard.data.SettingsStore
import com.monika.dashboard.network.ReportClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class MessageActionReceiver : BroadcastReceiver() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != MessageSocketManager.ACTION_BLOCK_VIEWER) return
        val pending = goAsync()
        val appContext = context.applicationContext
        val viewerId = intent.getStringExtra(MessageSocketManager.EXTRA_VIEWER_ID).orEmpty()
        MessageSocketManager.blockViewer(appContext, viewerId)
        scope.launch {
            try {
                val settings = SettingsStore(appContext)
                val url = settings.serverUrl.first()
                val token = settings.getToken()
                if (url.isNotBlank() && !token.isNullOrBlank()) {
                    val client = ReportClient(url, token)
                    try {
                        client.blockViewer(viewerId)
                    } finally {
                        client.shutdown()
                    }
                }
            } finally {
                pending.finish()
            }
        }
        Toast.makeText(context, "已拉黑该网页访客", Toast.LENGTH_SHORT).show()
    }
}
