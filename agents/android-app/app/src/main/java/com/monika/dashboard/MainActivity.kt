package com.monika.dashboard

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.monika.dashboard.data.SettingsStore
import com.monika.dashboard.health.HealthConnectManager
import com.monika.dashboard.health.HealthSyncWorker
import com.monika.dashboard.realtime.MessageSocketManager
import com.monika.dashboard.ui.components.DashboardTone
import com.monika.dashboard.ui.components.InitialBadge
import com.monika.dashboard.ui.components.StatusPill
import com.monika.dashboard.ui.screens.BoardScreen
import com.monika.dashboard.ui.screens.HealthScreen
import com.monika.dashboard.ui.screens.MessagesScreen
import com.monika.dashboard.ui.screens.SetupScreen
import com.monika.dashboard.ui.screens.StatusScreen
import com.monika.dashboard.ui.theme.DashboardTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {

    private lateinit var settings: SettingsStore

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = SettingsStore(applicationContext)
        enableEdgeToEdge()
        requestNotificationPermission()
        MessageSocketManager.ensureStarted(applicationContext)

        setContent {
            DashboardTheme {
                Scaffold(
                    modifier = Modifier.fillMaxSize(),
                    topBar = { DashboardTopBar(settings) }
                ) { innerPadding ->
                    MainContent(
                        settings = settings,
                        modifier = Modifier.padding(innerPadding)
                    )
                }
            }
        }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    1001
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DashboardTopBar(settings: SettingsStore) {
    var connected by remember { mutableStateOf(false) }
    val serverUrl by settings.serverUrl.collectAsState(initial = "")

    LaunchedEffect(serverUrl) {
        while (true) {
            connected = MessageSocketManager.isConnected()
            delay(3000L)
        }
    }

    TopAppBar(
        title = {
            Column {
                Text("Monika Now", style = MaterialTheme.typography.titleLarge)
                Text(
                    text = "Android 采集与访客消息",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        actions = {
            StatusPill(
                text = if (connected) "实时已连接" else "实时等待连接",
                tone = if (connected) DashboardTone.Good else DashboardTone.Neutral,
                modifier = Modifier.padding(end = 16.dp),
            )
        },
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = MaterialTheme.colorScheme.background,
        ),
    )
}

@Composable
private fun MainContent(settings: SettingsStore, modifier: Modifier = Modifier) {
    var selectedTab by rememberSaveable { mutableIntStateOf(0) }
    val tabs = listOf(
        NavItem("私聊", "聊"),
        NavItem("公开", "板"),
        NavItem("健康", "健"),
        NavItem("设置", "设"),
        NavItem("诊断", "查"),
    )
    val context = LocalContext.current

    // Trigger foreground health sync once on app open
    LaunchedEffect(Unit) {
        val enabledTypes = settings.enabledHealthTypes.first()
        val url = settings.serverUrl.first()
        val token = withContext(Dispatchers.IO) { settings.getToken() }
        if (enabledTypes.isNotEmpty() && url.isNotEmpty() && !token.isNullOrEmpty()
            && HealthConnectManager.isAvailable(context)) {
            HealthSyncWorker.syncNow(context, foreground = true)
        }
    }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        bottomBar = {
            NavigationBar(
                containerColor = MaterialTheme.colorScheme.surface,
                tonalElevation = 0.dp,
            ) {
                tabs.forEachIndexed { index, item ->
                    NavigationBarItem(
                        selected = selectedTab == index,
                        onClick = { selectedTab = index },
                        icon = {
                            InitialBadge(
                                text = item.glyph,
                                tone = if (selectedTab == index) DashboardTone.Info else DashboardTone.Neutral,
                            )
                        },
                        label = { Text(item.title) },
                    )
                }
            }
        }
    ) { innerPadding ->
        Box(modifier = Modifier.fillMaxSize().padding(innerPadding)) {
            when (selectedTab) {
                0 -> MessagesScreen(settings)
                1 -> BoardScreen(settings)
                2 -> HealthScreen(settings)
                3 -> SetupScreen(settings)
                4 -> StatusScreen()
            }
        }
    }
}

private data class NavItem(
    val title: String,
    val glyph: String,
)
