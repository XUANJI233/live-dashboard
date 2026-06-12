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
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
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
import com.monika.dashboard.BuildConfig
import com.monika.dashboard.data.DebugLog
import com.monika.dashboard.data.SettingsStore
import com.monika.dashboard.network.ReportClient
import com.monika.dashboard.network.SupervisionRules
import com.monika.dashboard.system.LsposedConfigBridge
import com.monika.dashboard.ui.components.CompactPageHeader
import com.monika.dashboard.ui.components.DashboardCard
import com.monika.dashboard.ui.components.DashboardTone
import com.monika.dashboard.ui.components.PrimaryActionColors
import com.monika.dashboard.ui.components.SegmentedControl
import com.monika.dashboard.ui.components.SectionTitle
import com.monika.dashboard.ui.components.StatusBlock
import com.monika.dashboard.ui.components.StatusPill
import com.monika.dashboard.ui.components.friendlyErrorMessage
import com.monika.dashboard.ui.theme.Border
import com.monika.dashboard.ui.theme.TextMuted
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun SettingsHubScreen(
    settings: SettingsStore,
    selectedIndex: Int? = null,
    onSelectedIndexChange: ((Int) -> Unit)? = null,
) {
    val context = LocalContext.current
    var localSelected by rememberSaveable { mutableIntStateOf(0) }
    val selected = selectedIndex ?: localSelected
    val selectTab: (Int) -> Unit = {
        if (onSelectedIndexChange != null) {
            onSelectedIndexChange(it)
        } else {
            localSelected = it
        }
    }
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
                onSelect = selectTab,
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
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var mode by rememberSaveable { mutableStateOf("normal") }
    var target by rememberSaveable { mutableStateOf("") }
    var plannedRest by rememberSaveable { mutableStateOf(false) }
    var weeklyPlan by remember { mutableStateOf(defaultSummaryPlan()) }
    var dailySummaryTime by rememberSaveable { mutableStateOf("21:00") }
    var weeklySummaryWeekday by rememberSaveable { mutableIntStateOf(7) }
    var weeklySummaryTime by rememberSaveable { mutableStateOf("21:30") }
    var aiDeepThinking by rememberSaveable { mutableStateOf(true) }
    var supervisionEnabled by rememberSaveable { mutableStateOf(false) }
    var supervisionIncludeInstalledApps by rememberSaveable { mutableStateOf(true) }
    var supervisionCheckMode by rememberSaveable { mutableStateOf("hourly") }
    var supervisionCheckIntervalMinutes by rememberSaveable { mutableStateOf("60") }
    var supervisionBlacklistMinutes by rememberSaveable { mutableStateOf("20") }
    var supervisionTargetMinMinutes by rememberSaveable { mutableStateOf("25") }
    var supervisionVibrate by rememberSaveable { mutableStateOf(true) }
    var supervisionSkipWatchSleep by rememberSaveable { mutableStateOf(true) }
    var supervisionLspFreeze by rememberSaveable { mutableStateOf(false) }
    var supervisionRules by remember { mutableStateOf(SupervisionRules.empty()) }
    var supervisionRulesUpdatedAt by remember { mutableStateOf<String?>(null) }
    var supervisionRulesError by remember { mutableStateOf<String?>(null) }
    var supervisionRulesRefreshing by remember { mutableStateOf(false) }
    var unfreezeCountdown by rememberSaveable { mutableIntStateOf(0) }
    var unfreezeReady by rememberSaveable { mutableStateOf(false) }
    var targetSectionExpanded by rememberSaveable { mutableStateOf(false) }
    var promptSettingsExpanded by rememberSaveable { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var aiLoading by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    var aiStatus by remember { mutableStateOf<String?>(null) }
    var updatedAt by remember { mutableStateOf<String?>(null) }
    var localEditedAt by remember { mutableStateOf<String?>(null) }
    var aiApiUrl by rememberSaveable { mutableStateOf("") }
    var aiApiKey by remember { mutableStateOf("") }
    var aiModel by rememberSaveable { mutableStateOf("gpt-4o-mini") }
    var aiLocked by remember { mutableStateOf(false) }
    var aiConfigured by remember { mutableStateOf(false) }
    var aiModelOptions by remember { mutableStateOf<List<String>>(emptyList()) }
    var aiModelMenuExpanded by remember { mutableStateOf(false) }
    var showAiLockedDialog by remember { mutableStateOf(false) }

    fun markSummaryEdited() {
        localEditedAt = Instant.now().toString()
        status = "本地已修改，尚未上传"
    }

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
                    plannedRest = it.plannedRest
                    weeklyPlan = it.weeklyPlan
                    dailySummaryTime = it.dailySummaryTime
                    weeklySummaryWeekday = it.weeklySummaryWeekday
                    weeklySummaryTime = it.weeklySummaryTime
                    aiDeepThinking = it.aiDeepThinking
                    supervisionEnabled = it.supervisionEnabled
                    supervisionIncludeInstalledApps = it.supervisionIncludeInstalledApps
                    supervisionCheckMode = it.supervisionCheckMode
                    supervisionCheckIntervalMinutes = it.supervisionCheckIntervalMinutes.toString()
                    supervisionBlacklistMinutes = it.supervisionBlacklistMinutes.toString()
                    supervisionTargetMinMinutes = it.supervisionTargetMinMinutes.toString()
                    supervisionVibrate = it.supervisionVibrate
                    supervisionSkipWatchSleep = it.supervisionSkipWatchSleep
                    supervisionLspFreeze = it.supervisionLspFreeze
                    supervisionRules = it.supervisionRules
                    supervisionRulesUpdatedAt = it.supervisionRulesUpdatedAt
                    supervisionRulesError = it.supervisionRulesError
                    supervisionRulesRefreshing = it.rulesRefreshJobStatus in setOf("queued", "running")
                    updatedAt = it.updatedAt
                    localEditedAt = null
                    status = "已同步服务器设置"
                }
                .onFailure { status = friendlyErrorMessage(it) }
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
                    ReportClient(url, token).updateSummarySettings(
                        ReportClient.SummarySettingsUpdate(
                            mode = mode,
                            target = target,
                            plannedRest = plannedRest,
                            weeklyPlan = weeklyPlan,
                            dailySummaryTime = dailySummaryTime,
                            weeklySummaryWeekday = weeklySummaryWeekday,
                            weeklySummaryTime = weeklySummaryTime,
                            aiDeepThinking = aiDeepThinking,
                            supervisionEnabled = supervisionEnabled,
                            supervisionIncludeInstalledApps = supervisionIncludeInstalledApps,
                            supervisionCheckMode = supervisionCheckMode,
                            supervisionCheckIntervalMinutes = supervisionCheckIntervalMinutes.toIntervalSetting(60),
                            supervisionBlacklistMinutes = supervisionBlacklistMinutes.toMinuteSetting(20),
                            supervisionTargetMinMinutes = supervisionTargetMinMinutes.toMinuteSetting(25),
                            supervisionVibrate = supervisionVibrate,
                            supervisionSkipWatchSleep = supervisionSkipWatchSleep,
                            supervisionLspFreeze = supervisionLspFreeze,
                            clientUpdatedAt = localEditedAt ?: updatedAt ?: Instant.now().toString(),
                        ),
                    )
                }
            }
            result
                .onSuccess {
                    mode = it.mode
                    target = it.target
                    plannedRest = it.plannedRest
                    weeklyPlan = it.weeklyPlan
                    dailySummaryTime = it.dailySummaryTime
                    weeklySummaryWeekday = it.weeklySummaryWeekday
                    weeklySummaryTime = it.weeklySummaryTime
                    aiDeepThinking = it.aiDeepThinking
                    supervisionEnabled = it.supervisionEnabled
                    supervisionIncludeInstalledApps = it.supervisionIncludeInstalledApps
                    supervisionCheckMode = it.supervisionCheckMode
                    supervisionCheckIntervalMinutes = it.supervisionCheckIntervalMinutes.toString()
                    supervisionBlacklistMinutes = it.supervisionBlacklistMinutes.toString()
                    supervisionTargetMinMinutes = it.supervisionTargetMinMinutes.toString()
                    supervisionVibrate = it.supervisionVibrate
                    supervisionSkipWatchSleep = it.supervisionSkipWatchSleep
                    supervisionLspFreeze = it.supervisionLspFreeze
                    supervisionRules = it.supervisionRules
                    supervisionRulesUpdatedAt = it.supervisionRulesUpdatedAt
                    supervisionRulesError = it.supervisionRulesError
                    supervisionRulesRefreshing = it.rulesRefreshJobStatus in setOf("queued", "running")
                    updatedAt = it.updatedAt
                    localEditedAt = null
                    if (it.syncStatus == "ignored_stale") {
                        status = "服务器已有较新的计划，已同步最新配置"
                        Toast.makeText(context, "服务器已有较新的计划，已同步最新配置", Toast.LENGTH_LONG).show()
                    } else {
                        status = if (supervisionRulesRefreshing) {
                            "计划已保存，监督规则正在生成"
                        } else {
                            "计划已保存并同步到服务器"
                        }
                        Toast.makeText(context, "计划已同步到服务器", Toast.LENGTH_SHORT).show()
                    }
                }
                .onFailure { status = friendlyErrorMessage(it) }
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
                    aiConfigured = it.configured
                    aiApiUrl = it.apiUrl ?: it.apiUrlHint.orEmpty()
                    aiModel = it.model.ifBlank { "gpt-4o-mini" }
                    aiApiKey = ""
                    aiModelOptions = emptyList()
                    aiStatus = when {
                        it.locked -> it.message ?: "服务器已通过环境变量配置 AI"
                        it.configured -> "AI 配置已保存在服务器"
                        else -> "服务器还没有 AI 配置"
                    }
                }
                .onFailure { aiStatus = friendlyErrorMessage(it) }
            aiLoading = false
        }
    }

    fun testAiConnection() {
        scope.launch {
            aiLoading = true
            aiStatus = null
            val result = withContext(Dispatchers.IO) {
                val url = settings.serverUrl.first()
                val token = settings.getToken()
                if (url.isBlank() || token.isNullOrBlank()) {
                    Result.failure(IllegalStateException("请先配置服务器和 Token"))
                } else if (aiApiUrl.isBlank()) {
                    Result.failure(IllegalStateException("请填写 AI 端点"))
                } else if (aiApiKey.isBlank() && !aiConfigured) {
                    Result.failure(IllegalStateException("首次配置请填写 AI API Key；之后修改模型或端点时可以留空复用服务器已保存密钥"))
                } else {
                    ReportClient(url, token).testAiConfig(aiApiUrl, aiApiKey, aiModel)
                }
            }
            result
                .onSuccess {
                    aiModelOptions = it.models
                    val preferred = when {
                        it.selectedModel.isNotBlank() && it.models.contains(it.selectedModel) -> it.selectedModel
                        aiModel.isNotBlank() && it.models.contains(aiModel) -> aiModel
                        it.models.isNotEmpty() -> it.models.first()
                        else -> aiModel
                    }
                    aiModel = preferred.ifBlank { "gpt-4o-mini" }
                    aiStatus = if (it.ok) {
                        it.message
                    } else {
                        "测试失败：${it.message}"
                    }
                }
                .onFailure {
                    val message = friendlyErrorMessage(it)
                    aiStatus = message
                    if (message.contains("AI_CONFIG_LOCKED") || message.contains("环境变量")) {
                        showAiLockedDialog = true
                    }
                }
            aiLoading = false
        }
    }

    fun saveAiConfig() {
        scope.launch {
            aiLoading = true
            aiStatus = null
            val reusedKey = aiApiKey.isBlank()
            val result = withContext(Dispatchers.IO) {
                val url = settings.serverUrl.first()
                val token = settings.getToken()
                if (url.isBlank() || token.isNullOrBlank()) {
                    Result.failure(IllegalStateException("请先配置服务器和 Token"))
                } else if (aiApiUrl.isBlank()) {
                    Result.failure(IllegalStateException("请填写 AI 端点"))
                } else if (aiApiKey.isBlank() && !aiConfigured) {
                    Result.failure(IllegalStateException("首次配置请填写 AI API Key；之后修改模型或端点时可以留空复用服务器已保存密钥"))
                } else {
                    ReportClient(url, token).updateAiConfig(aiApiUrl, aiApiKey, aiModel)
                }
            }
            result
                .onSuccess {
                    aiLocked = it.locked
                    aiConfigured = it.configured
                    aiApiUrl = it.apiUrl ?: it.apiUrlHint.orEmpty()
                    aiModel = it.model.ifBlank { "gpt-4o-mini" }
                    aiModelOptions = emptyList()
                    aiApiKey = ""
                    aiStatus = if (reusedKey) "AI 配置已保存，沿用服务器已保存密钥" else "AI 配置已加密保存"
                }
                .onFailure {
                    val message = friendlyErrorMessage(it)
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

    LaunchedEffect(unfreezeCountdown) {
        if (unfreezeCountdown > 0) {
            delay(1000)
            val next = unfreezeCountdown - 1
            unfreezeCountdown = next
            if (next == 0) unfreezeReady = true
        }
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
                    markSummaryEdited()
                    mode = when (it) {
                        0 -> "gentle"
                        2 -> "sharp"
                        else -> "normal"
                    }
                },
            )
            SectionTitle(
                title = "目标与每周计划",
                meta = if (targetSectionExpanded) "已展开" else targetSummary(target, weeklyPlan),
            )
            TextButton(
                onClick = { targetSectionExpanded = !targetSectionExpanded },
                enabled = !loading,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (targetSectionExpanded) "收起目标设置" else "展开目标设置")
            }
            if (targetSectionExpanded) {
                OutlinedTextField(
                    value = target,
                    onValueChange = {
                        markSummaryEdited()
                        target = it.take(1000)
                    },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text(if (plannedRest) "默认休息安排 / 近期重点" else "默认目标") },
                    minLines = 3,
                    maxLines = 5,
                    supportingText = { Text("${target.length}/1000") },
                )
                com.monika.dashboard.ui.components.PreferenceSwitchRow(
                    checked = plannedRest,
                    title = "默认按休息日评价",
                    body = "日总结按恢复、睡眠和娱乐边界评价；周总结仍按每天目标判断节奏。",
                    enabled = !loading,
                    onChange = {
                        markSummaryEdited()
                        plannedRest = it
                    },
                )
                SectionTitle("每周计划")
                Text(
                    text = "只填写需要覆盖默认目标的日期；空白会复用上面的默认目标。",
                    style = MaterialTheme.typography.bodySmall,
                    color = TextMuted,
                )
                weeklyPlan.forEach { item ->
                    WeeklyPlanRow(
                        item = item,
                        enabled = !loading,
                        onTargetChange = { value ->
                            markSummaryEdited()
                            weeklyPlan = weeklyPlan.map { day ->
                                if (day.weekday == item.weekday) day.copy(target = value.take(1000)) else day
                            }
                        },
                    )
                }
            }
            SectionTitle("自动总结")
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                OutlinedTextField(
                    value = dailySummaryTime,
                    onValueChange = {
                        markSummaryEdited()
                        dailySummaryTime = normalizeClockInput(it)
                    },
                    modifier = Modifier.weight(1f),
                    enabled = !loading,
                    label = { Text("日总结时间") },
                    singleLine = true,
                )
                OutlinedTextField(
                    value = weeklySummaryTime,
                    onValueChange = {
                        markSummaryEdited()
                        weeklySummaryTime = normalizeClockInput(it)
                    },
                    modifier = Modifier.weight(1f),
                    enabled = !loading,
                    label = { Text("周总结时间") },
                    singleLine = true,
                )
            }
            SegmentedControl(
                options = listOf("周一", "周二", "周三", "周四", "周五", "周六", "周日"),
                selectedIndex = (weeklySummaryWeekday - 1).coerceIn(0, 6),
                onSelect = {
                    markSummaryEdited()
                    weeklySummaryWeekday = it + 1
                },
            )
            SectionTitle("AI 请求选项")
            com.monika.dashboard.ui.components.PreferenceSwitchRow(
                checked = aiDeepThinking,
                title = "打开深度思考",
                body = "使用统一 AI 开关；服务端只在当前供应商支持时转换为对应参数。",
                enabled = !loading,
                onChange = {
                    markSummaryEdited()
                    aiDeepThinking = it
                },
            )
            SectionTitle("监督模式")
            com.monika.dashboard.ui.components.PreferenceSwitchRow(
                checked = supervisionEnabled,
                title = "偏离目标时主动提醒",
                body = "保存计划时生成应用匹配规则；之后按间隔定时复核，或在阈值触发时由 AI 复核。",
                enabled = !loading,
                onChange = {
                    markSummaryEdited()
                    supervisionEnabled = it
                },
            )
            if (supervisionEnabled) {
                SegmentedControl(
                    options = listOf("定时复核", "阈值触发"),
                    selectedIndex = if (supervisionCheckMode == "triggered") 1 else 0,
                    onSelect = {
                        markSummaryEdited()
                        supervisionCheckMode = if (it == 1) "triggered" else "hourly"
                    },
                )
                OutlinedTextField(
                    value = supervisionCheckIntervalMinutes,
                    onValueChange = {
                        markSummaryEdited()
                        supervisionCheckIntervalMinutes = it.filter { ch -> ch.isDigit() }.take(3)
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !loading,
                    label = { Text("复核间隔分钟") },
                    singleLine = true,
                )
                com.monika.dashboard.ui.components.PreferenceSwitchRow(
                    checked = supervisionIncludeInstalledApps,
                    title = "发送应用列表辅助判断",
                    body = "只使用设备上报的非系统应用快照，帮助 AI 识别包名、VPN 和娱乐入口。",
                    enabled = !loading,
                    onChange = {
                        markSummaryEdited()
                        supervisionIncludeInstalledApps = it
                    },
                )
                com.monika.dashboard.ui.components.PreferenceSwitchRow(
                    checked = supervisionVibrate,
                    title = "偏离时震动",
                    body = "切回目标应用后停止。",
                    enabled = !loading,
                    onChange = {
                        markSummaryEdited()
                        supervisionVibrate = it
                    },
                )
                com.monika.dashboard.ui.components.PreferenceSwitchRow(
                    checked = supervisionSkipWatchSleep,
                    title = "睡着时跳过",
                    body = "仅使用手表睡眠数据判断，避免手机息屏误判。",
                    enabled = !loading,
                    onChange = {
                        markSummaryEdited()
                        supervisionSkipWatchSleep = it
                    },
                )
                if (BuildConfig.PRIVILEGED_FEATURES) {
                    com.monika.dashboard.ui.components.PreferenceSwitchRow(
                        checked = supervisionLspFreeze,
                        title = "LSPosed 短时冻结偏离应用",
                        body = "优先使用系统挂起；失败时才短时停止应用。系统、桌面、安全组件和本应用始终不会被冻结。",
                        enabled = !loading,
                        onChange = {
                            markSummaryEdited()
                            supervisionLspFreeze = it
                        },
                    )
                    Button(
                        onClick = {
                            if (unfreezeReady) {
                                val ok = LsposedConfigBridge.clearSupervisionFreeze(context.applicationContext)
                                unfreezeReady = false
                                unfreezeCountdown = 0
                                Toast.makeText(
                                    context,
                                    if (ok) "已请求解冻所有短时冻结应用" else "LSPosed 解冻广播发送失败",
                                    Toast.LENGTH_SHORT,
                                ).show()
                            } else {
                                unfreezeCountdown = 30
                                unfreezeReady = false
                            }
                        },
                        enabled = supervisionLspFreeze && !loading && unfreezeCountdown == 0,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            when {
                                unfreezeCountdown > 0 -> "解冻倒计时 ${unfreezeCountdown}s"
                                unfreezeReady -> "确认解冻所有冻结应用"
                                else -> "强制解冻所有冻结应用"
                            },
                        )
                    }
                }
                if (supervisionCheckMode == "triggered") {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        OutlinedTextField(
                            value = supervisionBlacklistMinutes,
                            onValueChange = {
                                markSummaryEdited()
                                supervisionBlacklistMinutes = it.filter { ch -> ch.isDigit() }.take(2)
                            },
                            modifier = Modifier.weight(1f),
                            enabled = !loading,
                            label = { Text("黑名单分钟") },
                            singleLine = true,
                        )
                        OutlinedTextField(
                            value = supervisionTargetMinMinutes,
                            onValueChange = {
                                markSummaryEdited()
                                supervisionTargetMinMinutes = it.filter { ch -> ch.isDigit() }.take(2)
                            },
                            modifier = Modifier.weight(1f),
                            enabled = !loading,
                            label = { Text("目标低于分钟") },
                            singleLine = true,
                        )
                    }
                }
                val supervisionMeta = when {
                    supervisionRulesRefreshing -> "监督规则正在生成，完成后会更新"
                    !supervisionRulesError.isNullOrBlank() -> "规则生成失败：${supervisionRulesError.orEmpty()}"
                    !supervisionRulesUpdatedAt.isNullOrBlank() -> "规则已更新 ${formatClock(supervisionRulesUpdatedAt.orEmpty())}"
                    else -> "保存后生成监督规则"
                }
                StatusBlock(
                    text = supervisionMeta,
                    tone = if (!supervisionRulesError.isNullOrBlank() && !supervisionRulesRefreshing) DashboardTone.Warn else DashboardTone.Neutral,
                )
                if (supervisionRules.hasContent()) {
                    SupervisionRulesView(supervisionRules)
                }
            }
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
            SectionTitle(
                title = "提示词设置",
                meta = if (promptSettingsExpanded) "已展开" else "已收起",
            )
            TextButton(
                onClick = { promptSettingsExpanded = !promptSettingsExpanded },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (promptSettingsExpanded) "收起提示词设置" else "展开提示词设置")
            }
            if (promptSettingsExpanded) {
                Text(
                    text = "服务端可通过 ai-prompts.json 覆盖日总结、周总结、监督规则和监督复核的 system prompt；空条目继续使用内置默认。这里不改变时间线、设备能力、当前时间和缓存切分请求结构。",
                    style = MaterialTheme.typography.bodySmall,
                    color = TextMuted,
                )
            }
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
            if (aiModelOptions.isNotEmpty()) {
                Box {
                    TextButton(
                        onClick = { aiModelMenuExpanded = true },
                        enabled = !aiLocked && !aiLoading,
                    ) {
                        Text("选择已获取模型（${aiModelOptions.size}）")
                    }
                    DropdownMenu(
                        expanded = aiModelMenuExpanded,
                        onDismissRequest = { aiModelMenuExpanded = false },
                    ) {
                        aiModelOptions.take(120).forEach { option ->
                            DropdownMenuItem(
                                text = { Text(option) },
                                onClick = {
                                    aiModel = option
                                    aiModelMenuExpanded = false
                                },
                            )
                        }
                    }
                }
            }
            OutlinedTextField(
                value = aiApiKey,
                onValueChange = { aiApiKey = it.take(4096) },
                modifier = Modifier.fillMaxWidth(),
                enabled = !aiLocked && !aiLoading,
                label = { Text("AI API Key") },
                placeholder = {
                    if (aiConfigured && aiApiKey.isBlank()) {
                        Text("••••••••")
                    }
                },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
            )
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Button(
                    onClick = { testAiConnection() },
                    enabled = !aiLocked && !aiLoading,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(if (aiLoading) "处理中" else "测试并获取模型")
                }
                Button(
                    onClick = { saveAiConfig() },
                    enabled = !aiLocked && !aiLoading,
                    colors = PrimaryActionColors(),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("保存 AI 配置")
                }
                TextButton(
                    onClick = { loadAiConfig() },
                    enabled = !aiLoading,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("读取")
                }
            }
            if (!aiStatus.isNullOrBlank()) {
                StatusBlock(
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

@Composable
private fun WeeklyPlanRow(
    item: ReportClient.SummaryPlanDay,
    enabled: Boolean,
    onTargetChange: (String) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            text = weekdayLabel(item.weekday),
            modifier = Modifier.padding(top = 18.dp),
            style = MaterialTheme.typography.labelLarge,
            color = TextMuted,
        )
        OutlinedTextField(
            value = item.target,
            onValueChange = onTargetChange,
            modifier = Modifier.weight(1f),
            enabled = enabled,
            label = { Text("当天目标") },
            minLines = 1,
            maxLines = 3,
        )
    }
}

private fun defaultSummaryPlan(): List<ReportClient.SummaryPlanDay> =
    (1..7).map { weekday -> ReportClient.SummaryPlanDay(weekday, "", false) }

private fun weekdayLabel(weekday: Int): String =
    listOf("周一", "周二", "周三", "周四", "周五", "周六", "周日")[(weekday - 1).coerceIn(0, 6)]

private fun normalizeClockInput(value: String): String =
    value.filter { it.isDigit() || it == ':' }.take(5)

private fun String.toMinuteSetting(fallback: Int): Int =
    toIntOrNull()?.coerceIn(1, 55) ?: fallback

private fun String.toIntervalSetting(fallback: Int): Int =
    toIntOrNull()?.coerceIn(30, 240) ?: fallback

private fun formatClock(value: String): String =
    runCatching {
        Instant.parse(value)
            .atZone(ZoneId.systemDefault())
            .format(DateTimeFormatter.ofPattern("HH:mm"))
    }
        .getOrDefault(value.take(16))

private fun targetSummary(target: String, weeklyPlan: List<ReportClient.SummaryPlanDay>): String {
    val weeklyOverrides = weeklyPlan.count { it.target.isNotBlank() }
    return when {
        target.isBlank() && weeklyOverrides == 0 -> "未设置"
        weeklyOverrides > 0 -> "${target.length}/1000，${weeklyOverrides}天覆盖"
        else -> "${target.length}/1000"
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
    val logVersion by DebugLog.version.collectAsState()
    val logs = remember(logVersion) { DebugLog.lines.joinToString("\n").ifBlank { "暂无日志" } }
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
