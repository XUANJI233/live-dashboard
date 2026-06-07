package com.monika.dashboard.ui.screens

import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.monika.dashboard.data.DebugLog
import com.monika.dashboard.data.SettingsStore
import com.monika.dashboard.ui.components.CompactPageHeader
import com.monika.dashboard.ui.components.SegmentedControl
import com.monika.dashboard.ui.theme.Border
import com.monika.dashboard.ui.theme.TextMuted

@Composable
fun SettingsHubScreen(settings: SettingsStore) {
    val context = LocalContext.current
    var selected by rememberSaveable { mutableIntStateOf(0) }
    var showLogs by remember { mutableStateOf(false) }

    Column(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 16.dp, top = 8.dp, end = 16.dp, bottom = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            CompactPageHeader(
                title = "设置",
                subtitle = "配置、健康和诊断集中管理。",
                action = {
                    TextButton(onClick = { showLogs = true }) {
                        Text("日志")
                    }
                },
            )
            SegmentedControl(
                options = listOf("配置", "健康", "诊断"),
                selectedIndex = selected,
                onSelect = { selected = it },
            )
        }

        Box(modifier = Modifier.weight(1f)) {
            when (selected) {
                1 -> HealthScreen(settings = settings, showHeader = false)
                2 -> StatusScreen(showHeader = false, showUploadStatus = false)
                else -> SetupScreen(settings = settings, showHeader = false)
            }
        }
    }

    if (showLogs) {
        LogsDialog(
            onDismiss = { showLogs = false },
            onExport = {
                exportLogs(context)
            },
        )
    }
}

@Composable
private fun LogsDialog(
    onDismiss: () -> Unit,
    onExport: () -> Unit,
) {
    val logs = DebugLog.lines.joinToString("\n").ifBlank { "暂无日志" }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("本地日志") },
        text = {
            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 180.dp, max = 420.dp),
                shape = RoundedCornerShape(12.dp),
                color = MaterialTheme.colorScheme.surfaceVariant,
                border = androidx.compose.foundation.BorderStroke(1.dp, Border),
            ) {
                Text(
                    text = logs,
                    modifier = Modifier
                        .padding(12.dp)
                        .verticalScroll(rememberScrollState()),
                    style = MaterialTheme.typography.bodySmall,
                    color = TextMuted,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = onExport) { Text("导出") }
        },
        dismissButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { DebugLog.clear() }) { Text("清空") }
                TextButton(onClick = onDismiss) { Text("关闭") }
            }
        },
    )
}

private fun exportLogs(context: android.content.Context) {
    val logs = DebugLog.lines.joinToString("\n").ifBlank { "暂无日志" }
    try {
        val sendIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "Monika Now Android logs")
            putExtra(Intent.EXTRA_TEXT, logs)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(Intent.createChooser(sendIntent, "导出日志").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: Exception) {
        Toast.makeText(context, "无法打开导出面板", Toast.LENGTH_SHORT).show()
    }
}
