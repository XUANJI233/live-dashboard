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
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.monika.dashboard.data.DebugLog
import com.monika.dashboard.data.SettingsStore
import com.monika.dashboard.network.ReportClient
import com.monika.dashboard.ui.components.CompactPageHeader
import com.monika.dashboard.ui.components.DashboardCard
import com.monika.dashboard.ui.components.DashboardTone
import com.monika.dashboard.ui.components.PrimaryActionColors
import com.monika.dashboard.ui.components.SegmentedControl
import com.monika.dashboard.ui.components.SectionTitle
import com.monika.dashboard.ui.components.StatusPill
import com.monika.dashboard.ui.theme.Border
import com.monika.dashboard.ui.theme.TextMuted
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

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
                subtitle = "配置、健康、总结和诊断集中管理。",
                action = {
                    TextButton(onClick = { showLogs = true }) {
                        Text("日志")
                    }
                },
            )
            SegmentedControl(
                options = listOf("配置", "健康", "总结", "诊断"),
                selectedIndex = selected,
                onSelect = { selected = it },
            )
        }

        Box(modifier = Modifier.weight(1f)) {
            when (selected) {
                1 -> HealthScreen(settings = settings, showHeader = false)
                2 -> SummarySettingsPane(settings)
                3 -> StatusScreen(showHeader = false, showUploadStatus = false)
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
private fun SummarySettingsPane(settings: SettingsStore) {
    val scope = rememberCoroutineScope()
    var mode by rememberSaveable { mutableStateOf("normal") }
    var target by rememberSaveable { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    var aiLoading by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    var aiStatus by remember { mutableStateOf<String?>(null) }
    var updatedAt by remember { mutableStateOf<String?>(null) }
    var aiApiUrl by rememberSaveable { mutableStateOf("") }
    var aiApiKey by remember { mutableStateOf("") }
    var aiModel by rememberSaveable { mutableStateOf("gpt-4o-mini") }
    var aiLocked by remember { mutableStateOf(false) }
    var showAiLockedDialog by remember { mutableStateOf(false) }

    fun loadRemote() {
        scope.launch {
            loading = true
            status = null
            val result = withContext(Dispatchers.IO) {
                val url = settings.serverUrl.first()
                val token = settings.getToken()
                if (url.isBlank() || token.isNullOrBlank()) {
                    Result.failure(IllegalStateException("请先配置服务器和 Token"))
                } else {
                    ReportClient(url, token).fetchSummarySettings()
                }
            }
            result
                .onSuccess {
                    mode = it.mode
                    target = it.target
                    updatedAt = it.updatedAt
                    status = "已同步服务器设置"
                }
                .onFailure { status = it.message ?: "同步失败" }
            loading = false
        }
    }

    fun saveRemote() {
        scope.launch {
            loading = true
            status = null
            val result = withContext(Dispatchers.IO) {
                val url = settings.serverUrl.first()
                val token = settings.getToken()
                if (url.isBlank() || token.isNullOrBlank()) {
                    Result.failure(IllegalStateException("请先配置服务器和 Token"))
                } else {
                    ReportClient(url, token).updateSummarySettings(mode, target)
                }
            }
            result
                .onSuccess {
                    mode = it.mode
                    target = it.target
                    updatedAt = it.updatedAt
                    status = "总结设置已保存"
                }
                .onFailure { status = it.message ?: "保存失败" }
            loading = false
        }
    }

    fun loadAiConfig() {
        scope.launch {
            aiLoading = true
            aiStatus = null
            val result = withContext(Dispatchers.IO) {
                val url = settings.serverUrl.first()
                val token = settings.getToken()
                if (url.isBlank() || token.isNullOrBlank()) {
                    Result.failure(IllegalStateException("请先配置服务器和 Token"))
                } else {
                    ReportClient(url, token).fetchAiConfig()
                }
            }
            result
                .onSuccess {
                    aiLocked = it.locked
                    aiApiUrl = it.apiUrl ?: it.apiUrlHint.orEmpty()
                    aiModel = it.model.ifBlank { "gpt-4o-mini" }
                    aiStatus = when {
                        it.locked -> it.message ?: "服务器已通过环境变量配置 AI"
                        it.configured -> "AI 配置已保存在服务器"
                        else -> "服务器还没有 AI 配置"
                    }
                }
                .onFailure { aiStatus = it.message ?: "AI 配置读取失败" }
            aiLoading = false
        }
    }

    fun saveAiConfig() {
        scope.launch {
            aiLoading = true
            aiStatus = null
            val result = withContext(Dispatchers.IO) {
                val url = settings.serverUrl.first()
                val token = settings.getToken()
                if (url.isBlank() || token.isNullOrBlank()) {
                    Result.failure(IllegalStateException("请先配置服务器和 Token"))
                } else if (aiApiUrl.isBlank() || aiApiKey.isBlank()) {
                    Result.failure(IllegalStateException("请填写 AI 端点和 Key"))
                } else {
                    ReportClient(url, token).updateAiConfig(aiApiUrl, aiApiKey, aiModel)
                }
            }
            result
                .onSuccess {
                    aiLocked = it.locked
                    aiApiUrl = it.apiUrl ?: it.apiUrlHint.orEmpty()
                    aiModel = it.model.ifBlank { "gpt-4o-mini" }
                    aiApiKey = ""
                    aiStatus = "AI 配置已加密保存"
                }
                .onFailure {
                    val message = it.message ?: "AI 配置保存失败"
                    aiStatus = message
                    if (message.contains("AI_CONFIG_LOCKED") || message.contains("环境变量")) {
                        showAiLockedDialog = true
                    }
                }
            aiLoading = false
        }
    }

    LaunchedEffect(Unit) {
        loadRemote()
        loadAiConfig()
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        DashboardCard(tone = DashboardTone.Info) {
            SectionTitle(
                title = "AI 总结",
                meta = updatedAt?.let { "已更新" } ?: if (loading) "同步中" else null,
            )
            SegmentedControl(
                options = listOf("温和", "一般", "锐评"),
                selectedIndex = when (mode) {
                    "gentle" -> 0
                    "sharp" -> 2
                    else -> 1
                },
                onSelect = {
                    mode = when (it) {
                        0 -> "gentle"
                        2 -> "sharp"
                        else -> "normal"
                    }
                },
            )
            OutlinedTextField(
                value = target,
                onValueChange = { target = it.take(240) },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("近期目标") },
                minLines = 3,
                maxLines = 5,
                supportingText = { Text("${target.length}/240") },
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Button(
                    onClick = { saveRemote() },
                    enabled = !loading,
                    colors = PrimaryActionColors(),
                    modifier = Modifier.weight(1f),
                ) {
                    Text(if (loading) "处理中" else "保存")
                }
                TextButton(
                    onClick = { loadRemote() },
                    enabled = !loading,
                    modifier = Modifier.weight(1f),
                ) {
                    Text("重新读取")
                }
            }
            if (!status.isNullOrBlank()) {
                StatusPill(
                    text = status.orEmpty(),
                    tone = if (
                        status?.contains("失败") == true ||
                        status?.startsWith("HTTP") == true ||
                        status?.startsWith("请先") == true
                    ) {
                        DashboardTone.Bad
                    } else {
                        DashboardTone.Good
                    },
                )
            }
        }

        DashboardCard {
            SectionTitle("提示词行为")
            Text(
                text = "模式和目标保存在服务器。日总结和周总结手动刷新时会读取这份设置，并把目标加入提示词；公开读取只返回总结文本，不返回目标。",
                style = MaterialTheme.typography.bodySmall,
                color = TextMuted,
            )
        }

        DashboardCard {
            SectionTitle(
                title = "AI 连接",
                meta = if (aiLoading) "同步中" else if (aiLocked) "环境变量锁定" else null,
            )
            Text(
                text = "AI Key 上传时使用 X25519 临时密钥协商和 AES-256-GCM 加密，设备 Token 只用于管理员鉴权和附加签名。",
                style = MaterialTheme.typography.bodySmall,
                color = TextMuted,
            )
            OutlinedTextField(
                value = aiApiUrl,
                onValueChange = { aiApiUrl = it.take(300) },
                modifier = Modifier.fillMaxWidth(),
                enabled = !aiLocked && !aiLoading,
                label = { Text("AI API 端点") },
                singleLine = true,
            )
            OutlinedTextField(
                value = aiModel,
                onValueChange = { aiModel = it.take(120) },
                modifier = Modifier.fillMaxWidth(),
                enabled = !aiLocked && !aiLoading,
                label = { Text("模型") },
                singleLine = true,
            )
            OutlinedTextField(
                value = aiApiKey,
                onValueChange = { aiApiKey = it.take(4096) },
                modifier = Modifier.fillMaxWidth(),
                enabled = !aiLocked && !aiLoading,
                label = { Text("AI API Key") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Button(
                    onClick = { saveAiConfig() },
                    enabled = !aiLocked && !aiLoading,
                    colors = PrimaryActionColors(),
                    modifier = Modifier.weight(1f),
                ) {
                    Text(if (aiLoading) "处理中" else "保存 AI 配置")
                }
                TextButton(
                    onClick = { loadAiConfig() },
                    enabled = !aiLoading,
                    modifier = Modifier.weight(1f),
                ) {
                    Text("读取")
                }
            }
            if (!aiStatus.isNullOrBlank()) {
                StatusPill(
                    text = aiStatus.orEmpty(),
                    tone = if (isAiStatusError(aiStatus)) {
                        DashboardTone.Bad
                    } else if (aiLocked) {
                        DashboardTone.Warn
                    } else {
                        DashboardTone.Good
                    },
                )
            }
        }
    }

    if (showAiLockedDialog) {
        AlertDialog(
            onDismissRequest = { showAiLockedDialog = false },
            title = { Text("服务器已锁定 AI 配置") },
            text = {
                Text("服务端已通过 AI_API_URL / AI_API_KEY 环境变量配置 AI。为避免覆盖线上密钥，服务器拒绝 App 上传配置。")
            },
            confirmButton = {
                TextButton(onClick = { showAiLockedDialog = false }) { Text("知道了") }
            },
        )
    }
}

private fun isAiStatusError(status: String?): Boolean {
    val value = status ?: return false
    return listOf("失败", "LOCKED").any(value::contains) ||
        listOf("HTTP", "请").any(value::startsWith)
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
