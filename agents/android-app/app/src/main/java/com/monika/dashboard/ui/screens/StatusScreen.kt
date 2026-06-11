package com.monika.dashboard.ui.screens

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.monika.dashboard.data.DebugLog
import com.monika.dashboard.data.SettingsStore
import com.monika.dashboard.data.UploadItem
import com.monika.dashboard.data.UploadStatus
import com.monika.dashboard.data.UploadStatusStore
import com.monika.dashboard.health.BackgroundReadAvailability
import com.monika.dashboard.health.HealthConnectManager
import com.monika.dashboard.ui.components.DashboardCard
import com.monika.dashboard.ui.components.DashboardTone
import com.monika.dashboard.ui.components.EmptyState
import com.monika.dashboard.ui.components.InitialBadge
import com.monika.dashboard.ui.components.ScreenHeader
import com.monika.dashboard.ui.components.SectionTitle
import com.monika.dashboard.ui.components.StatusPill
import com.monika.dashboard.ui.theme.Border
import com.monika.dashboard.ui.theme.TextMuted
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.coroutines.cancellation.CancellationException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun StatusScreen(showHeader: Boolean = true, showUploadStatus: Boolean = true) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var healthAvailable by remember { mutableStateOf(false) }
    var backgroundReadAvailability by remember { mutableStateOf<BackgroundReadAvailability?>(null) }
    var bgPermGranted by remember { mutableStateOf(false) }
    val hcManager = remember(context) { HealthConnectManager(context.applicationContext) }
    val settings = remember(context) { SettingsStore(context.applicationContext) }
    val debugMode by settings.debugMode.collectAsState(initial = false)
    val logVersion by DebugLog.version.collectAsState()

    LaunchedEffect(lifecycleOwner) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            healthAvailable = HealthConnectManager.isAvailable(context)
            if (healthAvailable) {
                val (availability, permGranted) = withContext(Dispatchers.IO) {
                    val availability = try {
                        hcManager.getBackgroundReadAvailability()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        BackgroundReadAvailability(false, errorMessage = e.message ?: e.javaClass.simpleName)
                    }
                    val granted = try {
                        hcManager.getGrantedPermissions()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        emptySet()
                    }
                    Pair(availability, hcManager.backgroundReadPermission in granted)
                }
                backgroundReadAvailability = availability
                bgPermGranted = permGranted
            } else {
                backgroundReadAvailability = null
                bgPermGranted = false
            }
        }
    }

    var tick by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(3000)
            tick++
        }
    }

    val pm = remember { context.getSystemService(android.content.Context.POWER_SERVICE) as? PowerManager }
    var batteryOptimized by remember {
        mutableStateOf(pm?.isIgnoringBatteryOptimizations(context.packageName) == true)
    }

    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                batteryOptimized = pm?.isIgnoringBatteryOptimizations(context.packageName) == true
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val manufacturer = remember { Build.MANUFACTURER.lowercase(Locale.ROOT) }
    val permissionRows = buildList {
        add(DiagnosticAction(
            label = "Health Connect",
            ok = healthAvailable,
            body = "健康记录读取入口。",
            action = {
                try {
                    context.startActivity(
                        Intent("android.health.connect.action.HEALTH_HOME_SETTINGS").apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        },
                    )
                } catch (e: Exception) {
                    DebugLog.log("设置", "无法打开 Health Connect 设置: ${e.message}")
                    Toast.makeText(context, "请安装 Health Connect 应用", Toast.LENGTH_SHORT).show()
                }
            },
        ))
        add(DiagnosticAction(
            label = "电池优化已忽略",
            ok = batteryOptimized,
            body = "用于提高后台同步和消息连接稳定性。",
            action = {
                try {
                    context.startActivity(
                        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                            data = Uri.parse("package:${context.packageName}")
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        },
                    )
                } catch (e: Exception) {
                    DebugLog.log("设置", "电池优化直接请求失败: ${e.message}")
                    try {
                        context.startActivity(
                            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            },
                        )
                    } catch (e2: Exception) {
                        DebugLog.log("设置", "电池优化设置页也无法打开: ${e2.message}")
                        Toast.makeText(context, "无法打开电池优化设置", Toast.LENGTH_SHORT).show()
                    }
                }
            },
        ))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val notifPermGranted = context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
            add(DiagnosticAction(
                label = "通知权限",
                ok = notifPermGranted,
                body = "访客消息和后台提示需要通知权限。",
                action = {
                    try {
                        context.startActivity(
                            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                                putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            },
                        )
                    } catch (e: Exception) {
                        DebugLog.log("设置", "无法打开通知设置: ${e.message}")
                        Toast.makeText(context, "无法打开通知设置", Toast.LENGTH_SHORT).show()
                    }
                },
            ))
        }
        add(DiagnosticAction(
            label = "辅助功能采集",
            ok = isAccessibilityEnabled(context),
            body = "普通模式读取前台应用和窗口标题。",
            action = {
                context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            },
        ))
        add(DiagnosticAction(
            label = "通知监听",
            ok = isNotificationListenerEnabled(context),
            body = "普通模式采集音乐/视频通知兜底。",
            action = {
                context.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            },
        ))
    }

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
                    title = "诊断",
                    subtitle = "检查权限、后台能力、上传结果和本地调试输出。",
                    meta = "每 3 秒刷新",
                )
            }
        }

        item {
            SectionTitle("权限和服务", meta = "${permissionRows.count { it.ok }}/${permissionRows.size} 正常")
        }
        items(permissionRows, key = { it.label }) { row ->
            DiagnosticRow(row)
        }

        if (healthAvailable) {
            item {
                BackgroundHealthCard(
                    availability = backgroundReadAvailability,
                    granted = bgPermGranted,
                    onGrant = {
                        try {
                            context.startActivity(
                                Intent("android.health.connect.action.MANAGE_HEALTH_PERMISSIONS").apply {
                                    putExtra("android.intent.extra.PACKAGE_NAME", context.packageName)
                                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                },
                            )
                        } catch (_: Exception) {
                            try {
                                context.startActivity(
                                    Intent("android.health.connect.action.HEALTH_HOME_SETTINGS").apply {
                                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                    },
                                )
                            } catch (_: Exception) {
                                Toast.makeText(context, "无法打开 Health Connect 设置", Toast.LENGTH_SHORT).show()
                            }
                        }
                    },
                )
            }
        }

        manufacturerOemTip(manufacturer)?.let { tip ->
            item {
                DashboardCard(tone = DashboardTone.Warn) {
                    SectionTitle("厂商后台设置")
                    Text(text = tip, style = MaterialTheme.typography.bodySmall, color = TextMuted)
                    if (manufacturer.contains("xiaomi") || manufacturer.contains("redmi")) {
                        TextButton(
                            onClick = {
                                try {
                                    context.startActivity(
                                        Intent().apply {
                                            component = android.content.ComponentName(
                                                "com.miui.securitycenter",
                                                "com.miui.permcenter.autostart.AutoStartManagementActivity",
                                            )
                                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                        },
                                    )
                                } catch (e: Exception) {
                                    DebugLog.log("设置", "小米自启动页打开失败: ${e.message}")
                                    try {
                                        context.startActivity(
                                            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                                                data = Uri.parse("package:${context.packageName}")
                                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                            },
                                        )
                                    } catch (e2: Exception) {
                                        DebugLog.log("设置", "应用详情页也无法打开: ${e2.message}")
                                        Toast.makeText(context, "请手动前往设置中的自启动管理", Toast.LENGTH_LONG).show()
                                    }
                                }
                            },
                        ) {
                            Text("打开设置")
                        }
                    }
                }
            }
        }

        if (showUploadStatus) {
            item { SectionTitle("上传状态") }
            items(UploadItem.entries, key = { it.key }) { item ->
                val status = remember(tick) { UploadStatusStore.read(context, item) }
                UploadStatusRow(item.label, status)
            }
        }

        item { SectionTitle("调试") }
        if (debugMode) {
            item {
                DebugPayloadCard(remember(tick) { UploadStatusStore.getLastPayload(context) })
            }
            item {
                DebugLogCard(remember(tick, logVersion) { DebugLog.lines })
            }
        } else {
            item {
                EmptyState(
                    title = "调试模式已关闭",
                    body = "需要查看上传 payload 或本地日志时，请在设置页开启调试模式。",
                )
            }
        }

        item { Spacer(modifier = Modifier.height(8.dp)) }
    }
}

private data class DiagnosticAction(
    val label: String,
    val ok: Boolean,
    val body: String,
    val action: () -> Unit,
)

@Composable
private fun DiagnosticRow(row: DiagnosticAction) {
    DashboardCard(
        tone = if (row.ok) DashboardTone.Good else DashboardTone.Bad,
        contentPadding = 12.dp,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            InitialBadge(
                text = if (row.ok) "OK" else "FIX",
                tone = if (row.ok) DashboardTone.Good else DashboardTone.Bad,
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(text = row.label, style = MaterialTheme.typography.titleSmall)
                Text(text = row.body, style = MaterialTheme.typography.bodySmall, color = TextMuted)
            }
            if (!row.ok) {
                TextButton(onClick = row.action) { Text("去设置") }
            }
        }
    }
}

@Composable
private fun BackgroundHealthCard(
    availability: BackgroundReadAvailability?,
    granted: Boolean,
    onGrant: () -> Unit,
) {
    val featureAvailable = availability?.isAvailable == true
    val checkFailed = !availability?.errorMessage.isNullOrEmpty()
    val enabled = granted && featureAvailable
    DashboardCard(
        tone = when {
            enabled -> DashboardTone.Good
            checkFailed -> DashboardTone.Warn
            else -> DashboardTone.Neutral
        },
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(text = "后台健康同步", style = MaterialTheme.typography.titleMedium)
            StatusPill(
                text = if (enabled) "可用" else "需确认",
                tone = if (enabled) DashboardTone.Good else DashboardTone.Warn,
            )
        }
        Text(
            text = when {
                enabled -> "已授权后台读取健康数据，将按设定间隔自动同步。"
                checkFailed -> "后台读取能力检测失败：${availability?.errorMessage ?: "未知错误"}。仍可尝试授权，实际同步时会再次校验。"
                featureAvailable -> "设备支持后台读取，但还没有授权后台读取权限。"
                else -> "当前设备或 Health Connect 版本未开放后台读取；打开 App 时仍会前台同步当天数据。"
            },
            style = MaterialTheme.typography.bodySmall,
            color = TextMuted,
        )
        if (!granted && (featureAvailable || checkFailed)) {
            TextButton(onClick = onGrant) { Text("授权后台同步") }
        }
    }
}

@Composable
private fun UploadStatusRow(label: String, status: UploadStatus?) {
    val tone = when {
        status == null -> DashboardTone.Neutral
        status.ok -> DashboardTone.Good
        else -> DashboardTone.Bad
    }
    DashboardCard(tone = tone, contentPadding = 12.dp) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            InitialBadge(
                text = when {
                    status == null -> "--"
                    status.ok -> "OK"
                    else -> "ERR"
                },
                tone = tone,
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(text = label, style = MaterialTheme.typography.titleSmall)
                Text(
                    text = status?.let { if (it.ok) "上传成功 ${formatDebugTime(it.at)}" else "上传失败 ${formatDebugTime(it.at)}" }
                        ?: "未上传",
                    style = MaterialTheme.typography.bodySmall,
                    color = TextMuted,
                )
                if (!status?.message.isNullOrBlank()) {
                    Text(
                        text = status?.message.orEmpty(),
                        style = MaterialTheme.typography.bodySmall,
                        color = TextMuted,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun DebugPayloadCard(payload: String) {
    DashboardCard {
        SectionTitle("最近上传 payload")
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 100.dp, max = 260.dp),
            shape = RoundedCornerShape(10.dp),
            color = MaterialTheme.colorScheme.surfaceVariant,
            border = androidx.compose.foundation.BorderStroke(1.dp, Border),
        ) {
            Text(
                text = payload.ifBlank { "暂无上传 payload" },
                style = MaterialTheme.typography.bodySmall,
                color = TextMuted,
                modifier = Modifier
                    .padding(12.dp)
                    .verticalScroll(rememberScrollState()),
            )
        }
    }
}

@Composable
private fun DebugLogCard(lines: List<String>) {
    DashboardCard {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(text = "本地日志", style = MaterialTheme.typography.titleMedium)
            TextButton(onClick = { DebugLog.clear() }) { Text("清空") }
        }
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 120.dp, max = 320.dp),
            shape = RoundedCornerShape(10.dp),
            color = MaterialTheme.colorScheme.surfaceVariant,
            border = androidx.compose.foundation.BorderStroke(1.dp, Border),
        ) {
            if (lines.isEmpty()) {
                Box(
                    modifier = Modifier.fillMaxSize().padding(16.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(text = "暂无日志", style = MaterialTheme.typography.bodySmall, color = TextMuted)
                }
            } else {
                Column(
                    modifier = Modifier
                        .padding(10.dp)
                        .verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    lines.forEach { line ->
                        Text(text = line, style = MaterialTheme.typography.bodySmall, color = TextMuted)
                    }
                }
            }
        }
    }
}

private fun formatDebugTime(millis: Long): String =
    if (millis <= 0) "--" else SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(millis))

private fun isNotificationListenerEnabled(context: android.content.Context): Boolean {
    val enabled = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")
    return enabled?.contains(context.packageName, ignoreCase = true) == true
}

private fun isAccessibilityEnabled(context: android.content.Context): Boolean {
    val enabled = Settings.Secure.getInt(context.contentResolver, Settings.Secure.ACCESSIBILITY_ENABLED, 0) == 1
    if (!enabled) return false
    val services = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
    return !services.isNullOrBlank() && services.split(':').any {
        it.contains(context.packageName, ignoreCase = true)
    }
}

private fun manufacturerOemTip(manufacturer: String): String? =
    when {
        manufacturer.contains("xiaomi") || manufacturer.contains("redmi") ->
            "小米/Redmi：在应用详情中允许自启动，并将省电策略设置为无限制。"
        manufacturer.contains("samsung") ->
            "三星：从后台使用限制和深度睡眠列表中移除 Monika Now。"
        manufacturer.contains("oppo") || manufacturer.contains("realme") || manufacturer.contains("oneplus") ->
            "OPPO/Realme/一加：允许后台运行和自启动，关闭智能功耗管理限制。"
        manufacturer.contains("vivo") ->
            "vivo：允许后台高耗电，并确认自启动权限。"
        else -> null
    }
