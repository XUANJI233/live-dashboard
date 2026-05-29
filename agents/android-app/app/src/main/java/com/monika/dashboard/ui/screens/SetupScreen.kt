package com.monika.dashboard.ui.screens

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.clickable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
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
import com.monika.dashboard.ui.theme.Primary
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.cancellation.CancellationException

@Composable
fun SetupScreen(settings: SettingsStore) {
    val scope = rememberCoroutineScope()
    val scrollState = rememberScrollState()
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
    val uploadInputState by settings.uploadInputState.collectAsState(initial = false)
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
    var inputStateInput by remember(uploadInputState) { mutableStateOf(uploadInputState) }
    var highFrequencyInput by remember(highFrequencyReport) { mutableStateOf(highFrequencyReport) }
    var debugInput by remember(debugMode) { mutableStateOf(debugMode) }

    // Load token asynchronously to avoid blocking main thread
    LaunchedEffect(Unit) {
        try {
            val token = withContext(Dispatchers.IO) { settings.getToken() }
            tokenInput = token ?: ""
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            tokenInput = ""
        }
    }
    var showToken by remember { mutableStateOf(false) }
    var statusMsg by remember { mutableStateOf<String?>(null) }
    var urlError by remember { mutableStateOf<String?>(null) }
    val snackbarHostState = remember { SnackbarHostState() }

    fun notifySaved(message: String = "已自动保存") {
        statusMsg = message
        scope.launch { snackbarHostState.showSnackbar(message) }
    }

    fun rescheduleIfMonitoring() {
        if (monitoringEnabled) {
            val minInterval = if (highFrequencyInput) {
                HeartbeatWorker.MIN_INTERVAL_SECONDS
            } else {
                HeartbeatWorker.DEFAULT_INTERVAL_SECONDS
            }
            val seconds = intervalInput.toIntOrNull()?.coerceIn(
                minInterval,
                HeartbeatWorker.MAX_INTERVAL_SECONDS,
            ) ?: HeartbeatWorker.DEFAULT_INTERVAL_SECONDS
            HeartbeatWorker.schedule(context, seconds)
        }
    }

    Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { scaffoldPadding ->
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(scrollState)
            .padding(scaffoldPadding)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text(
            text = "服务器配置",
            style = MaterialTheme.typography.headlineMedium
        )

        // Server URL
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
            placeholder = { Text("https://your-dashboard.example.com:9443") },
            isError = urlError != null,
            supportingText = urlError?.let { err -> { Text(err) } }
                ?: { Text("必须使用 HTTPS（仅 localhost 允许 HTTP）") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(8.dp)
        )

        Text(text = "采集模式", style = MaterialTheme.typography.titleSmall)
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            CapabilityOption(
                selected = modeInput == "normal",
                title = "normal",
                body = "只上报在线、电量和健康数据，不读取当前应用"
            ) {
                modeInput = "normal"
                scope.launch { settings.setCapabilityMode("normal"); notifySaved() }
            }
            if (BuildConfig.PRIVILEGED_FEATURES) {
                CapabilityOption(
                    selected = modeInput == "lsposed",
                    title = "Root / LSPosed",
                    body = "由 LSPosed 模块直接上传；App 仅负责配置。若模块未激活，则不会上传当前应用/媒体状态。"
                ) {
                    modeInput = "lsposed"
                    scope.launch { settings.setCapabilityMode("lsposed"); notifySaved() }
                }
            } else {
                Text(
                    text = "普通版不包含 root/LSPosed 采集；需要高级能力请安装 Root 版本。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Text(text = "可选上报", style = MaterialTheme.typography.titleSmall)
        OptionalSwitch(
            checked = highFrequencyInput,
            title = "高频上报",
            body = "每5秒上传一次状态,但更加耗电"
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
            title = "当前应用/页面",
            body = if (BuildConfig.PRIVILEGED_FEATURES) {
                "LSPosed 模式由模块直接采集前台应用和浏览器页面标题"
            } else {
                "普通模式使用辅助功能采集应用名和窗口/网页/视频页面标题"
            }
        ) {
            foregroundInput = it
            scope.launch { settings.setUploadForeground(it); notifySaved() }
        }
        UploadSwitch(
            item = UploadItem.MEDIA,
            checked = mediaInput,
            title = "视频/音乐",
            body = if (BuildConfig.PRIVILEGED_FEATURES) {
                "LSPosed 模式由模块直接采集系统媒体会话（标题/艺术家/播放状态）"
            } else {
                "普通模式使用媒体通知兜底，尽量只采集播放类通知"
            }
        ) {
            mediaInput = it
            scope.launch { settings.setUploadMedia(it); notifySaved() }
        }
        UploadSwitch(
            item = UploadItem.NETWORK,
            checked = networkInput,
            title = "网络状态",
            body = "只上传是否联网，不上传访问域名或流量内容"
        ) {
            networkInput = it
            scope.launch { settings.setUploadNetwork(it); notifySaved() }
        }
        OptionalSwitch(
            checked = locationInput,
            title = "上传位置",
            body = "仅使用最近已知位置，不主动高频定位"
        ) {
            locationInput = it
            scope.launch {
                settings.setUploadLocation(it)
                if (it) requestLocationPermissionIfNeeded(context)
                notifySaved()
            }
        }
        OptionalSwitch(
            checked = vpnInput,
            title = "上传 VPN 状态",
            body = "只上传是否连接 VPN，不上传流量或域名"
        ) {
            vpnInput = it
            scope.launch { settings.setUploadVpnStatus(it); notifySaved() }
        }
        OptionalSwitch(
            checked = inputStateInput,
            title = "上传输入状态",
            body = "只上传是否正在输入，不上传文本、剪贴板或候选词"
        ) {
            inputStateInput = it
            scope.launch { settings.setUploadInputState(it); notifySaved() }
        }
        OptionalSwitch(
            checked = debugInput,
            title = "调试模式",
            body = "显示最近上传 payload 和本地调试日志；关闭后调试页不展示这些内容"
        ) {
            debugInput = it
            scope.launch { settings.setDebugMode(it); notifySaved(if (it) "调试模式已开启" else "调试模式已关闭") }
        }

        // Token
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
            visualTransformation = if (showToken) VisualTransformation.None
                else PasswordVisualTransformation(),
            trailingIcon = {
                TextButton(onClick = { showToken = !showToken }) {
                    Text(if (showToken) "隐藏" else "显示")
                }
            },
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(8.dp)
        )

        // Report Interval
        OutlinedTextField(
            value = intervalInput,
            onValueChange = {
                intervalInput = it.filter { c -> c.isDigit() }
                val seconds = intervalInput.toIntOrNull()
                if (seconds != null) {
                    val minInterval = if (highFrequencyInput) {
                        HeartbeatWorker.MIN_INTERVAL_SECONDS
                    } else {
                        HeartbeatWorker.DEFAULT_INTERVAL_SECONDS
                    }
                    val safeSeconds = seconds.coerceIn(minInterval, HeartbeatWorker.MAX_INTERVAL_SECONDS)
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
                Text(
                    if (highFrequencyInput) {
                        "${HeartbeatWorker.MIN_INTERVAL_SECONDS}-${HeartbeatWorker.MAX_INTERVAL_SECONDS} 秒（高频更耗电）"
                    } else {
                        "${HeartbeatWorker.DEFAULT_INTERVAL_SECONDS}-${HeartbeatWorker.MAX_INTERVAL_SECONDS} 秒（开启高频后可到 ${HeartbeatWorker.MIN_INTERVAL_SECONDS} 秒）"
                    }
                )
            },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(8.dp)
        )

        // Save Button
        Button(
            onClick = {
                scope.launch {
                    try {
                        val url = urlInput.trim()
                        if (!SettingsStore.validateUrl(url)) {
                            urlError = "地址无效：必须使用 HTTPS 或 http://localhost"
                            return@launch
                        }
                        if (!settings.isSecureStorageAvailable) {
                            statusMsg = "无法保存：安全存储不可用"
                            return@launch
                        }
                        settings.setServerUrl(url)
                        withContext(Dispatchers.IO) { settings.setToken(tokenInput) }
                        val minInterval = if (highFrequencyInput) {
                            HeartbeatWorker.MIN_INTERVAL_SECONDS
                        } else {
                            HeartbeatWorker.DEFAULT_INTERVAL_SECONDS
                        }
                        val seconds = intervalInput.toIntOrNull()?.coerceIn(
                            minInterval,
                            HeartbeatWorker.MAX_INTERVAL_SECONDS,
                        ) ?: HeartbeatWorker.DEFAULT_INTERVAL_SECONDS
                        settings.setReportInterval(seconds)
                        settings.setCapabilityMode(modeInput)
                        settings.setHighFrequencyReport(highFrequencyInput)
                        settings.setUploadForeground(foregroundInput)
                        settings.setUploadMedia(mediaInput)
                        settings.setUploadNetwork(networkInput)
                        settings.setUploadLocation(locationInput)
                        settings.setUploadVpnStatus(vpnInput)
                        settings.setUploadInputState(inputStateInput)
                        settings.setDebugMode(debugInput)
                        withContext(Dispatchers.IO) { LsposedConfigBridge.publish(context, settings) }
                        if (locationInput) requestLocationPermissionIfNeeded(context)
                        intervalInput = seconds.toString()
                        if (monitoringEnabled) {
                            HeartbeatWorker.schedule(context, seconds)
                            notifySaved("设置已保存，并已应用新的心跳间隔（${seconds} 秒）")
                        } else {
                            notifySaved("设置已保存")
                        }
                    } catch (e: Exception) {
                        statusMsg = "保存失败：${e.message}"
                    }
                }
            },
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(8.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Primary)
        ) {
            Text("保存设置")
        }

        // Start/Stop monitoring toggle
        Button(
            onClick = {
                scope.launch {
                    val newState = !monitoringEnabled
                    settings.setMonitoringEnabled(newState)
                    if (newState) {
                        val minInterval = if (highFrequencyInput) {
                            HeartbeatWorker.MIN_INTERVAL_SECONDS
                        } else {
                            HeartbeatWorker.DEFAULT_INTERVAL_SECONDS
                        }
                        val seconds = intervalInput.toIntOrNull()?.coerceIn(
                            minInterval,
                            HeartbeatWorker.MAX_INTERVAL_SECONDS,
                        ) ?: HeartbeatWorker.DEFAULT_INTERVAL_SECONDS
                        settings.setReportInterval(seconds)
                        settings.setCapabilityMode(modeInput)
                        settings.setHighFrequencyReport(highFrequencyInput)
                        settings.setUploadForeground(foregroundInput)
                        settings.setUploadMedia(mediaInput)
                        settings.setUploadNetwork(networkInput)
                        settings.setUploadLocation(locationInput)
                        settings.setUploadVpnStatus(vpnInput)
                        settings.setUploadInputState(inputStateInput)
                        settings.setDebugMode(debugInput)
                        LsposedConfigBridge.publish(context, settings)
                        if (locationInput) requestLocationPermissionIfNeeded(context)
                        intervalInput = seconds.toString()
                        HeartbeatWorker.schedule(context, seconds)
                        MessageSocketManager.ensureStarted(context)
                        statusMsg = "监听已开启，当前间隔 ${seconds} 秒"
                    } else {
                        HeartbeatWorker.cancel(context)
                        MessageSocketManager.stop()
                        statusMsg = "监听已关闭"
                    }
                }
            },
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(8.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = if (monitoringEnabled)
                    MaterialTheme.colorScheme.error
                else Primary
            )
        ) {
            Text(if (monitoringEnabled) "关闭监听" else "开始监听")
        }

        // Status message
        statusMsg?.let { msg ->
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(8.dp),
                color = MaterialTheme.colorScheme.surfaceVariant
            ) {
                Text(
                    text = msg,
                    modifier = Modifier.padding(12.dp),
                    style = MaterialTheme.typography.bodyMedium
                )
            }
        }

        // Secure storage warning
        if (!settings.isSecureStorageAvailable) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(8.dp),
                color = MaterialTheme.colorScheme.errorContainer
            ) {
                Text(
                    text = "安全存储不可用，Token 无法安全保存。",
                    modifier = Modifier.padding(12.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onErrorContainer
                )
            }
        }
    }
    }
}

@Composable
private fun UploadSwitch(
    item: UploadItem,
    checked: Boolean,
    title: String,
    body: String,
    onChange: (Boolean) -> Unit,
) {
    val context = LocalContext.current
    val status = remember(checked) { UploadStatusStore.read(context, item) }
    val statusText = status?.let {
        "${if (it.ok) "上传成功" else "上传失败"} ${formatStatusTime(it.at)}"
    }
    val statusColor = status?.let {
        if (it.ok) Color(0xFF2E7D32) else MaterialTheme.colorScheme.error
    } ?: MaterialTheme.colorScheme.onSurface
    OptionalSwitch(
        checked = checked,
        title = if (statusText == null) title else "$title · $statusText",
        body = body,
        titleColor = statusColor,
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
        modifier = Modifier.fillMaxWidth().clickable(onClick = onSelect),
        shape = RoundedCornerShape(8.dp),
        color = if (selected) MaterialTheme.colorScheme.secondaryContainer
            else MaterialTheme.colorScheme.surfaceVariant,
    ) {
        Row(
            modifier = Modifier.padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            RadioButton(selected = selected, onClick = onSelect)
            Column {
                Text(text = title, style = MaterialTheme.typography.labelLarge)
                Text(text = body, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun OptionalSwitch(
    checked: Boolean,
    title: String,
    body: String,
    titleColor: Color? = null,
    onChange: (Boolean) -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
    ) {
        Row(
            modifier = Modifier.padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Switch(checked = checked, onCheckedChange = onChange)
            Column {
                Text(
                    text = title,
                    style = MaterialTheme.typography.labelLarge,
                    color = titleColor ?: MaterialTheme.colorScheme.onSurface,
                )
                Text(text = body, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
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
            1002
        )
    } else if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q &&
        ActivityCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) !=
        PackageManager.PERMISSION_GRANTED
    ) {
        ActivityCompat.requestPermissions(
            activity,
            arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION),
            1003
        )
    }
}
