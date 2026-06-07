package com.monika.dashboard.ui.screens

import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.health.connect.client.PermissionController
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.monika.dashboard.data.DebugLog
import com.monika.dashboard.data.SettingsStore
import com.monika.dashboard.health.BackgroundReadAvailability
import com.monika.dashboard.health.HealthConnectManager
import com.monika.dashboard.health.HealthDataType
import com.monika.dashboard.health.HealthSyncWorker
import com.monika.dashboard.ui.components.DashboardCard
import com.monika.dashboard.ui.components.DashboardTone
import com.monika.dashboard.ui.components.EmptyState
import com.monika.dashboard.ui.components.InitialBadge
import com.monika.dashboard.ui.components.ScreenHeader
import com.monika.dashboard.ui.components.SectionTitle
import com.monika.dashboard.ui.components.StatusPill
import com.monika.dashboard.ui.theme.TextMuted
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.launch

@Composable
fun HealthScreen(settings: SettingsStore) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val enabledTypes by settings.enabledHealthTypes.collectAsState(initial = emptySet())
    val syncInterval by settings.healthSyncInterval.collectAsState(initial = 15)
    val requestedDataPermissions = remember(enabledTypes) {
        enabledTypes
            .mapNotNull { key -> HealthDataType.fromKey(key)?.permission }
            .toSet()
            .ifEmpty { HealthDataType.entries.map { it.permission }.toSet() }
    }

    var isAvailable by remember { mutableStateOf(HealthConnectManager.isAvailable(context)) }
    var isInstalled by remember { mutableStateOf(HealthConnectManager.isInstalled(context)) }
    var permissionsGranted by remember { mutableStateOf(false) }
    var backgroundPermissionGranted by remember { mutableStateOf(false) }
    var backgroundAvailability by remember { mutableStateOf<BackgroundReadAvailability?>(null) }
    val lifecycleOwner = LocalLifecycleOwner.current
    val hcManager = remember(context) { HealthConnectManager(context) }

    suspend fun refreshHealthPermissionState() {
        isAvailable = HealthConnectManager.isAvailable(context)
        isInstalled = HealthConnectManager.isInstalled(context)
        if (!isAvailable) {
            permissionsGranted = false
            backgroundPermissionGranted = false
            backgroundAvailability = null
            return
        }

        try {
            val granted = hcManager.getGrantedPermissions()
            permissionsGranted = requestedDataPermissions.all { it in granted }
            backgroundPermissionGranted = hcManager.backgroundReadPermission in granted
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            permissionsGranted = false
            backgroundPermissionGranted = false
        }

        try {
            backgroundAvailability = hcManager.getBackgroundReadAvailability()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            backgroundAvailability = null
        }
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = PermissionController.createRequestPermissionResultContract(),
        onResult = {
            scope.launch {
                refreshHealthPermissionState()
                if (enabledTypes.isNotEmpty()) {
                    HealthSyncWorker.schedule(context, syncInterval)
                }
            }
        },
    )

    LaunchedEffect(lifecycleOwner, requestedDataPermissions) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            refreshHealthPermissionState()
        }
    }

    val backgroundFeatureAvailable = backgroundAvailability?.isAvailable == true
    val backgroundFeatureCheckFailed = !backgroundAvailability?.errorMessage.isNullOrEmpty()
    val canRequestBackgroundPermission =
        isAvailable && permissionsGranted && (backgroundFeatureAvailable || backgroundFeatureCheckFailed)
    val healthTone = when {
        isAvailable && permissionsGranted -> DashboardTone.Good
        isInstalled -> DashboardTone.Warn
        else -> DashboardTone.Bad
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            ScreenHeader(
                title = "健康",
                subtitle = "健康记录由 Health Connect 授权读取，和设备状态分开展示。",
                meta = "${enabledTypes.size}/${HealthDataType.entries.size} 已选",
            )
        }

        item {
            DashboardCard(tone = healthTone) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        SectionTitle("Health Connect")
                        Text(
                            text = when {
                                isAvailable -> if (permissionsGranted) "已授权，可读取所选健康记录。" else "可用，但还需要授权读取权限。"
                                isInstalled -> "已安装但未就绪，请打开 Health Connect 完成初始化。"
                                else -> "未安装 Health Connect。"
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = TextMuted,
                        )
                    }
                    StatusPill(
                        text = when {
                            isAvailable && permissionsGranted -> "可同步"
                            isAvailable -> "待授权"
                            isInstalled -> "待初始化"
                            else -> "未安装"
                        },
                        tone = healthTone,
                    )
                }
                if (!isInstalled) {
                    OutlinedButton(
                        onClick = {
                            try {
                                context.startActivity(
                                    Intent(Intent.ACTION_VIEW).apply {
                                        data = Uri.parse(
                                            "https://play.google.com/store/apps/details?id=com.google.android.apps.healthdata",
                                        )
                                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                                    },
                                )
                            } catch (_: Exception) {
                                Toast.makeText(context, "无法打开应用商店", Toast.LENGTH_SHORT).show()
                            }
                        },
                        shape = RoundedCornerShape(10.dp),
                    ) {
                        Text("安装 Health Connect")
                    }
                } else if (isAvailable && !permissionsGranted) {
                    Button(
                        onClick = { permissionLauncher.launch(requestedDataPermissions) },
                        shape = RoundedCornerShape(10.dp),
                    ) {
                        Text("授权健康数据")
                    }
                }
            }
        }

        item {
            DashboardCard {
                SectionTitle("后台同步")
                Text(
                    text = when {
                        !isAvailable ->
                            "Health Connect 不可用时不会安排健康同步。"
                        backgroundFeatureAvailable && backgroundPermissionGranted ->
                            "后台读取权限已授权，将按设定间隔自动同步。"
                        backgroundFeatureAvailable ->
                            "设备支持后台读取，但还需要额外授权。"
                        backgroundFeatureCheckFailed ->
                            "暂时无法确认后台读取能力；可以尝试授权，Worker 执行时还会再次校验。"
                        else ->
                            "当前设备或 Health Connect 版本未开放后台读取。打开 App 时仍会前台同步当天数据。"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = TextMuted,
                )
                if (!backgroundPermissionGranted && canRequestBackgroundPermission) {
                    OutlinedButton(
                        onClick = { permissionLauncher.launch(setOf(hcManager.backgroundReadPermission)) },
                        shape = RoundedCornerShape(10.dp),
                    ) {
                        Text(if (backgroundFeatureCheckFailed) "尝试授权后台同步" else "授权后台同步")
                    }
                }
            }
        }

        item {
            DashboardCard {
                SectionTitle("同步控制", meta = "${syncInterval} 分钟")
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    listOf(15, 30, 60).forEach { mins ->
                        FilterChip(
                            selected = syncInterval == mins,
                            onClick = {
                                scope.launch {
                                    settings.setHealthSyncInterval(mins)
                                    if (enabledTypes.isNotEmpty()) {
                                        HealthSyncWorker.schedule(context, mins)
                                    }
                                }
                            },
                            label = { Text("${mins}分") },
                        )
                    }
                }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Button(
                        onClick = {
                            scope.launch {
                                HealthSyncWorker.syncNow(context, foreground = true)
                                DebugLog.log("健康", "已触发立即同步")
                            }
                        },
                        enabled = isAvailable && enabledTypes.isNotEmpty(),
                        modifier = Modifier.weight(1f),
                        shape = RoundedCornerShape(10.dp),
                    ) {
                        Text("立即同步")
                    }
                    OutlinedButton(
                        onClick = {
                            scope.launch {
                                HealthSyncWorker.syncNow(context, foreground = true, fullSync = true)
                                DebugLog.log("健康", "已触发全量同步（7天）")
                            }
                        },
                        enabled = isAvailable && enabledTypes.isNotEmpty(),
                        modifier = Modifier.weight(1f),
                        shape = RoundedCornerShape(10.dp),
                    ) {
                        Text("全量同步")
                    }
                }
            }
        }

        item {
            SectionTitle("数据类型", meta = "按需授权")
        }

        if (HealthDataType.entries.isEmpty()) {
            item {
                EmptyState("没有可同步类型", "当前构建未包含 Health Connect 数据类型。")
            }
        } else {
            items(HealthDataType.entries.toList(), key = { it.key }) { type ->
                val checked = type.key in enabledTypes
                DashboardCard(
                    tone = if (checked) DashboardTone.Info else DashboardTone.Neutral,
                    contentPadding = 12.dp,
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        InitialBadge(
                            text = type.icon,
                            tone = if (checked) DashboardTone.Info else DashboardTone.Neutral,
                        )
                        Column(modifier = Modifier.weight(1f)) {
                            Text(text = type.displayName, style = MaterialTheme.typography.titleSmall)
                            Text(text = type.unit, style = MaterialTheme.typography.bodySmall, color = TextMuted)
                        }
                        Switch(
                            checked = checked,
                            onCheckedChange = { isChecked ->
                                scope.launch {
                                    val updated = if (isChecked) {
                                        enabledTypes + type.key
                                    } else {
                                        enabledTypes - type.key
                                    }
                                    settings.setEnabledHealthTypes(updated)
                                    if (updated.isNotEmpty()) {
                                        HealthSyncWorker.schedule(context, syncInterval)
                                    } else {
                                        HealthSyncWorker.cancel(context)
                                    }
                                }
                            },
                            enabled = isAvailable,
                        )
                    }
                }
            }
        }

        item { Spacer(modifier = Modifier.height(8.dp)) }
    }
}
