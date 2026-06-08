package com.monika.dashboard.ui.screens

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import com.monika.dashboard.BuildConfig
import com.monika.dashboard.data.SettingsStore
import com.monika.dashboard.data.UploadItem
import com.monika.dashboard.data.UploadStatusStore
import com.monika.dashboard.realtime.MessageSocketManager
import com.monika.dashboard.service.HeartbeatWorker
import com.monika.dashboard.system.LsposedConfigBridge
import com.monika.dashboard.ui.components.CompactDivider
import com.monika.dashboard.ui.components.DashboardCard
import com.monika.dashboard.ui.components.DashboardSwitchColors
import com.monika.dashboard.ui.components.DashboardTone
import com.monika.dashboard.ui.components.ScreenHeader
import com.monika.dashboard.ui.components.SectionTitle
import com.monika.dashboard.ui.components.StatusPill
import com.monika.dashboard.ui.theme.TextMuted
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.cancellation.CancellationException

@Composable
fun SetupScreen(settings: SettingsStore, showHeader: Boolean = true) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    val serverUrl by settings.serverUrl.collectAsState(initial = "")
    val reportInterval by settings.reportInterval.collectAsState(initial = HeartbeatWorker.DEFAULT_INTERVAL_SECONDS)
    val monitoringEnabled by settings.monitoringEnabled.collectAsState(initial = false)
    val capabilityMode by settings.capabilityMode.collectAsState(initial = "normal")
    val uploadForeground by settings.uploadForeground.collectAsState(initial = true)
    val uploadMedia by settings.uploadMedia.collectAsState(initial = true)
    val uploadNetwork by settings.uploadNetwork.collectAsState(initial = true)
    val uploadLocation by settings.uploadLocation.collectAsState(initial = false)
    val uploadVpnStatus by settings.uploadVpnStatus.collectAsState(initial = false)
    val highFrequencyReport by settings.highFrequencyReport.collectAsState(initial = false)
    val debugMode by settings.debugMode.collectAsState(initial = false)

    var urlInput by remember(serverUrl) { mutableStateOf(serverUrl) }
    var tokenInput by remember { mutableStateOf("") }
    var intervalInput by remember(reportInterval) { mutableStateOf(reportInterval.toString()) }
    var modeInput by remember(capabilityMode) { mutableStateOf(capabilityMode) }
    var foregroundInput by remember(uploadForeground) { mutableStateOf(uploadForeground) }
    var mediaInput by remember(uploadMedia) { mutableStateOf(uploadMedia) }
    var networkInput by remember(uploadNetwork) { mutableStateOf(uploadNetwork) }
    var locationInput by remember(uploadLocation) { mutableStateOf(uploadLocation) }
    var vpnInput by remember(uploadVpnStatus) { mutableStateOf(uploadVpnStatus) }
    var highFrequencyInput by remember(highFrequencyReport) { mutableStateOf(highFrequencyReport) }
    var debugInput by remember(debugMode) { mutableStateOf(debugMode) }
    var showToken by remember { mutableStateOf(false) }
    var statusMsg by remember { mutableStateOf<String?>(null) }
    var urlError by remember { mutableStateOf<String?>(null) }
    var uploadStatusTick by remember { mutableIntStateOf(0) }
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(Unit) {
        try {
            tokenInput = withContext(Dispatchers.IO) { settings.getToken() }.orEmpty()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            tokenInput = ""
        }
    }

    LaunchedEffect(Unit) {
        while (true) {
            delay(3000)
            uploadStatusTick++
        }
    }

    fun notifySaved(message: String = "已自动保存") {
        statusMsg = message
        scope.launch { snackbarHostState.showSnackbar(message) }
    }

    suspend fun publishLsposedConfig() {
        if (BuildConfig.PRIVILEGED_FEATURES) {
            withContext(Dispatchers.IO) { LsposedConfigBridge.publish(context, settings) }
        }
    }

    fun safeInterval(): Int {
        val minInterval = if (highFrequencyInput) {
            HeartbeatWorker.MIN_INTERVAL_SECONDS
        } else {
            HeartbeatWorker.DEFAULT_INTERVAL_SECONDS
        }
        return intervalInput.toIntOrNull()?.coerceIn(
            minInterval,
            HeartbeatWorker.MAX_INTERVAL_SECONDS,
        ) ?: HeartbeatWorker.DEFAULT_INTERVAL_SECONDS
    }

    fun rescheduleIfMonitoring() {
        if (monitoringEnabled) {
            HeartbeatWorker.schedule(context, safeInterval())
        }
    }

    Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { scaffoldPadding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(scaffoldPadding),
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
                        title = "设置",
                        subtitle = "连接、采集范围和本地上报行为集中在这里配置。",
                        meta = if (monitoringEnabled) "监听中" else "未监听",
                    )
                }
            }

            item {
                DashboardCard {
                    SectionTitle("连接")
                    OutlinedTextField(
                        value = urlInput,
                        onValueChange = {
                            urlInput = it
                            urlError = null
                            val url = it.trim()
                            if (SettingsStore.validateUrl(url)) {
                                scope.launch {
                                    settings.setServerUrl(url)
                                    notifySaved()
                                }
                            }
                        },
                        label = { Text("服务器地址") },
                        placeholder = { Text("https://live.example.com") },
                        isError = urlError != null,
                        supportingText = urlError?.let { err -> { Text(err) } }
                            ?: { Text("必须使用 HTTPS；HTTP 仅支持 localhost/127.0.0.1。模拟器连电脑本地服务需先 adb reverse。") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(10.dp),
                    )
                    OutlinedTextField(
                        value = tokenInput,
                        onValueChange = {
                            tokenInput = it
                            if (settings.isSecureStorageAvailable) {
                                scope.launch {
                                    withContext(Dispatchers.IO) { settings.setToken(it) }
                                    notifySaved()
                                }
                            }
                        },
                        label = { Text("Token 密钥") },
                        singleLine = true,
                        visualTransformation = if (showToken) {
                            VisualTransformation.None
                        } else {
                            PasswordVisualTransformation()
                        },
                        trailingIcon = {
                            TextButton(onClick = { showToken = !showToken }) {
                                Text(if (showToken) "隐藏" else "显示")
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(10.dp),
                    )
                    if (!settings.isSecureStorageAvailable) {
                        StatusMessage("安全存储不可用，Token 无法安全保存。", DashboardTone.Bad)
                    }
                }
            }

            item {
                DashboardCard {
                    SectionTitle("采集模式")
                    CapabilityOption(
                        selected = modeInput == "normal",
                        title = "普通模式",
                        body = "上报在线、电量、网络和健康数据，不读取当前应用。",
                    ) {
                        modeInput = "normal"
                        scope.launch {
                            settings.setCapabilityMode("normal")
                            publishLsposedConfig()
                            notifySaved()
                        }
                    }
                    if (BuildConfig.PRIVILEGED_FEATURES) {
                        CapabilityOption(
                            selected = modeInput == "lsposed",
                            title = "Root / LSPosed",
                            body = "由系统进程模块采集前台应用、浏览器标题和媒体状态；App 只保存配置。",
                        ) {
                            modeInput = "lsposed"
                            scope.launch {
                                settings.setCapabilityMode("lsposed")
                                publishLsposedConfig()
                                notifySaved()
                            }
                        }
                    } else {
                        StatusMessage("普通版不包含 Root / LSPosed 采集能力。", DashboardTone.Info)
                    }
                }
            }

            item {
                DashboardCard {
                    SectionTitle("上报范围")
                    SettingSwitchRow(
                        checked = highFrequencyInput,
                        title = "高频上报",
                        body = "每 5 秒上传一次状态；只在确实需要实时细节时开启。",
                    ) {
                        highFrequencyInput = it
                        scope.launch {
                            settings.setHighFrequencyReport(it)
                            rescheduleIfMonitoring()
                            notifySaved(if (it) "高频上报已开启" else "高频上报已关闭")
                        }
                    }
                    UploadSwitch(
                        item = UploadItem.FOREGROUND,
                        checked = foregroundInput,
                        title = "前台应用和页面",
                        statusTick = uploadStatusTick,
                        body = if (BuildConfig.PRIVILEGED_FEATURES) {
                            "LSPosed 模式由模块直接采集应用、Activity 和浏览器页面标题。"
                        } else {
                            "普通模式使用辅助功能采集应用名和窗口标题。"
                        },
                    ) {
                        foregroundInput = it
                        scope.launch { settings.setUploadForeground(it); notifySaved() }
                    }
                    UploadSwitch(
                        item = UploadItem.MEDIA,
                        checked = mediaInput,
                        title = "媒体状态",
                        statusTick = uploadStatusTick,
                        body = if (BuildConfig.PRIVILEGED_FEATURES) {
                            "LSPosed 模式读取系统媒体会话的标题、艺术家和播放状态。"
                        } else {
                            "普通模式使用媒体通知作为兜底。"
                        },
                    ) {
                        mediaInput = it
                        scope.launch { settings.setUploadMedia(it); notifySaved() }
                    }
                    UploadSwitch(
                        item = UploadItem.NETWORK,
                        checked = networkInput,
                        title = "设备网络",
                        statusTick = uploadStatusTick,
                        body = "只上传联网、网络类型、蜂窝代际和 VPN 状态，不上传域名或流量内容。",
                    ) {
                        networkInput = it
                        scope.launch { settings.setUploadNetwork(it); notifySaved() }
                    }
                    SettingSwitchRow(
                        checked = locationInput,
                        title = "最近位置",
                        body = "只使用系统最近已知位置，不主动高频定位。",
                    ) {
                        locationInput = it
                        scope.launch {
                            settings.setUploadLocation(it)
                            if (it) requestLocationPermissionIfNeeded(context)
                            notifySaved()
                        }
                    }
                    SettingSwitchRow(
                        checked = vpnInput,
                        title = "VPN 状态",
                        body = "只上传是否连接 VPN 和系统提供的 VPN 名称。",
                    ) {
                        vpnInput = it
                        scope.launch { settings.setUploadVpnStatus(it); notifySaved() }
                    }
                    SettingSwitchRow(
                        checked = debugInput,
                        title = "调试模式",
                        body = "在诊断页显示最近上传 payload 和本地日志。",
                    ) {
                        debugInput = it
                        scope.launch {
                            settings.setDebugMode(it)
                            notifySaved(if (it) "调试模式已开启" else "调试模式已关闭")
                        }
                    }
                }
            }

            item {
                DashboardCard {
                    SectionTitle("心跳")
                    OutlinedTextField(
                        value = intervalInput,
                        onValueChange = {
                            intervalInput = it.filter { c -> c.isDigit() }
                            val seconds = intervalInput.toIntOrNull()
                            if (seconds != null) {
                                val safeSeconds = safeInterval()
                                scope.launch {
                                    settings.setReportInterval(safeSeconds)
                                    intervalInput = safeSeconds.toString()
                                    rescheduleIfMonitoring()
                                    notifySaved()
                                }
                            }
                        },
                        label = { Text("心跳间隔（秒）") },
                        supportingText = {
                            val minInterval = if (highFrequencyInput) {
                                HeartbeatWorker.MIN_INTERVAL_SECONDS
                            } else {
                                HeartbeatWorker.DEFAULT_INTERVAL_SECONDS
                            }
                            Text("$minInterval-${HeartbeatWorker.MAX_INTERVAL_SECONDS} 秒")
                        },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(10.dp),
                    )
                }
            }

            item {
                DashboardCard {
                    SectionTitle("操作")
                    Button(
                        onClick = {
                            scope.launch {
                                try {
                                    val url = urlInput.trim()
                                    if (!SettingsStore.validateUrl(url)) {
                                        urlError = "地址无效：必须使用 HTTPS，或 HTTP localhost/127.0.0.1"
                                        return@launch
                                    }
                                    if (!settings.isSecureStorageAvailable) {
                                        statusMsg = "无法保存：安全存储不可用"
                                        return@launch
                                    }
                                    val seconds = safeInterval()
                                    settings.setServerUrl(url)
                                    withContext(Dispatchers.IO) { settings.setToken(tokenInput) }
                                    settings.setReportInterval(seconds)
                                    settings.setCapabilityMode(modeInput)
                                    settings.setHighFrequencyReport(highFrequencyInput)
                                    settings.setUploadForeground(foregroundInput)
                                    settings.setUploadMedia(mediaInput)
                                    settings.setUploadNetwork(networkInput)
                                    settings.setUploadLocation(locationInput)
                                    settings.setUploadVpnStatus(vpnInput)
                                    settings.setDebugMode(debugInput)
                                    publishLsposedConfig()
                                    if (locationInput) requestLocationPermissionIfNeeded(context)
                                    intervalInput = seconds.toString()
                                    if (monitoringEnabled) {
                                        HeartbeatWorker.schedule(context, seconds)
                                        notifySaved("设置已保存，心跳间隔 ${seconds} 秒")
                                    } else {
                                        notifySaved("设置已保存")
                                    }
                                } catch (e: Exception) {
                                    statusMsg = "保存失败：${e.message}"
                                }
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(10.dp),
                    ) {
                        Text("保存设置")
                    }
                    OutlinedButton(
                        onClick = {
                            scope.launch {
                                val newState = !monitoringEnabled
                                settings.setMonitoringEnabled(newState)
                                if (newState) {
                                    val seconds = safeInterval()
                                    settings.setReportInterval(seconds)
                                    settings.setCapabilityMode(modeInput)
                                    settings.setHighFrequencyReport(highFrequencyInput)
                                    settings.setUploadForeground(foregroundInput)
                                    settings.setUploadMedia(mediaInput)
                                    settings.setUploadNetwork(networkInput)
                                    settings.setUploadLocation(locationInput)
                                    settings.setUploadVpnStatus(vpnInput)
                                    settings.setDebugMode(debugInput)
                                    publishLsposedConfig()
                                    if (locationInput) requestLocationPermissionIfNeeded(context)
                                    intervalInput = seconds.toString()
                                    HeartbeatWorker.schedule(context, seconds)
                                    MessageSocketManager.ensureStarted(context)
                                    statusMsg = "监听已开启，当前间隔 ${seconds} 秒"
                                } else {
                                    publishLsposedConfig()
                                    HeartbeatWorker.cancel(context)
                                    MessageSocketManager.stop()
                                    statusMsg = "监听已关闭"
                                }
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(10.dp),
                        colors = ButtonDefaults.outlinedButtonColors(
                            contentColor = if (monitoringEnabled) {
                                MaterialTheme.colorScheme.error
                            } else {
                                MaterialTheme.colorScheme.primary
                            },
                        ),
                    ) {
                        Text(if (monitoringEnabled) "关闭监听" else "开始监听")
                    }
                    statusMsg?.let { StatusMessage(it, DashboardTone.Info) }
                }
            }

            item { Spacer(modifier = Modifier.height(8.dp)) }
        }
    }
}

@Composable
private fun UploadSwitch(
    item: UploadItem,
    checked: Boolean,
    title: String,
    statusTick: Int,
    body: String,
    onChange: (Boolean) -> Unit,
) {
    val context = LocalContext.current
    val status = remember(checked, statusTick) { UploadStatusStore.read(context, item) }
    val statusText = status?.let {
        "${if (it.ok) "上传成功" else "上传失败"} ${formatStatusTime(it.at)}"
    }
    val tone = when {
        status == null -> DashboardTone.Neutral
        status.ok -> DashboardTone.Good
        else -> DashboardTone.Bad
    }
    SettingSwitchRow(
        checked = checked,
        title = title,
        body = body,
        trailing = statusText?.let { { StatusPill(text = it, tone = tone) } },
        onChange = onChange,
    )
}

private fun formatStatusTime(millis: Long): String {
    if (millis <= 0) return "--"
    return java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault())
        .format(java.util.Date(millis))
}

@Composable
private fun CapabilityOption(
    selected: Boolean,
    title: String,
    body: String,
    onSelect: () -> Unit,
) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onSelect),
        shape = RoundedCornerShape(10.dp),
        color = if (selected) {
            MaterialTheme.colorScheme.primaryContainer
        } else {
            MaterialTheme.colorScheme.surfaceVariant
        },
    ) {
        Row(
            modifier = Modifier.padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RadioButton(selected = selected, onClick = onSelect)
            Column(modifier = Modifier.weight(1f)) {
                Text(text = title, style = MaterialTheme.typography.titleSmall)
                Text(text = body, style = MaterialTheme.typography.bodySmall, color = TextMuted)
            }
        }
    }
}

@Composable
private fun SettingSwitchRow(
    checked: Boolean,
    title: String,
    body: String,
    trailing: (@Composable () -> Unit)? = null,
    onChange: (Boolean) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Switch(
                checked = checked,
                onCheckedChange = onChange,
                colors = DashboardSwitchColors(),
            )
            Column(modifier = Modifier.weight(1f)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(text = title, style = MaterialTheme.typography.titleSmall)
                    trailing?.invoke()
                }
                Text(text = body, style = MaterialTheme.typography.bodySmall, color = TextMuted)
            }
        }
        CompactDivider()
    }
}

@Composable
private fun StatusMessage(
    text: String,
    tone: DashboardTone,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(10.dp),
        color = toneSurface(tone),
    ) {
        Text(
            text = text,
            modifier = Modifier.padding(12.dp),
            style = MaterialTheme.typography.bodySmall,
            color = if (tone == DashboardTone.Bad) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
        )
    }
}

@Composable
private fun toneSurface(tone: DashboardTone): Color = when (tone) {
    DashboardTone.Good -> MaterialTheme.colorScheme.secondaryContainer
    DashboardTone.Warn -> MaterialTheme.colorScheme.tertiaryContainer
    DashboardTone.Bad -> MaterialTheme.colorScheme.errorContainer
    DashboardTone.Info -> MaterialTheme.colorScheme.primaryContainer
    DashboardTone.Neutral -> MaterialTheme.colorScheme.surfaceVariant
}

private fun requestLocationPermissionIfNeeded(context: android.content.Context) {
    val activity = context as? Activity ?: return
    val fineGranted = ActivityCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    val coarseGranted = ActivityCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    if (!fineGranted && !coarseGranted) {
        ActivityCompat.requestPermissions(
            activity,
            arrayOf(
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.ACCESS_FINE_LOCATION,
            ),
            1002,
        )
    } else if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q &&
        ActivityCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) !=
        PackageManager.PERMISSION_GRANTED
    ) {
        ActivityCompat.requestPermissions(
            activity,
            arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION),
            1003,
        )
    }
}
