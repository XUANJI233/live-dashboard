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
import com.monika.dashboard.ui.screens.MessagesHubScreen
import com.monika.dashboard.ui.screens.OverviewScreen
import com.monika.dashboard.ui.screens.SettingsHubScreen
import com.monika.dashboard.ui.theme.DashboardTheme
import kotlinx.coroutines.Dispatchers
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
                MainContent(settings = settings)
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

@Composable
private fun MainContent(settings: SettingsStore, modifier: Modifier = Modifier) {
    var selectedTab by rememberSaveable { mutableIntStateOf(0) }
    val tabs = listOf(
        NavItem("概览", "今"),
        NavItem("消息", "信"),
        NavItem("设置", "设"),
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
        modifier = modifier
            .fillMaxSize()
            .statusBarsPadding(),
        bottomBar = {
            NavigationBar(
                containerColor = MaterialTheme.colorScheme.surface,
                tonalElevation = 0.dp,
            ) {
                tabs.forEachIndexed { index, item ->
                    NavigationBarItem(
                        selected = selectedTab == index,
                        onClick = { selectedTab = index },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = MaterialTheme.colorScheme.primary,
                            selectedTextColor = MaterialTheme.colorScheme.primary,
                            unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                            unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
                            indicatorColor = MaterialTheme.colorScheme.primaryContainer,
                        ),
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
                0 -> OverviewScreen(settings)
                1 -> MessagesHubScreen(settings)
                2 -> SettingsHubScreen(settings)
            }
        }
    }
}

private data class NavItem(
    val title: String,
    val glyph: String,
)
