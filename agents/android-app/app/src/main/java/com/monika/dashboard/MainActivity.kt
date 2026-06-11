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
import androidx.compose.ui.platform.LocalConfiguration
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
    private var navigationRequest by mutableStateOf<DashboardNavigationRequest?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = SettingsStore(applicationContext)
        navigationRequest = DashboardNavigationRequest.from(intent)
        enableEdgeToEdge()
        requestNotificationPermission()
        MessageSocketManager.ensureStarted(applicationContext)

        setContent {
            DashboardTheme {
                MainContent(settings = settings, navigationRequest = navigationRequest)
            }
        }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        navigationRequest = DashboardNavigationRequest.from(intent)
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
private fun MainContent(
    settings: SettingsStore,
    navigationRequest: DashboardNavigationRequest?,
    modifier: Modifier = Modifier,
) {
    var selectedTab by rememberSaveable { mutableIntStateOf(0) }
    var selectedMessagesTab by rememberSaveable { mutableIntStateOf(0) }
    var selectedSettingsTab by rememberSaveable { mutableIntStateOf(0) }
    val tabs = listOf(
        NavItem("概览", "今"),
        NavItem("消息", "信"),
        NavItem("设置", "设"),
    )
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    val useNavigationRail = configuration.screenWidthDp > configuration.screenHeightDp

    LaunchedEffect(navigationRequest) {
        if (navigationRequest?.destination == MessageSocketManager.DESTINATION_MESSAGES) {
            selectedTab = 1
            selectedMessagesTab = when (navigationRequest.messagesSection) {
                "public" -> 1
                else -> 0
            }
        }
    }

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

    if (useNavigationRail) {
        Row(
            modifier = modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding(),
        ) {
            DashboardNavigationRail(
                tabs = tabs,
                selectedTab = selectedTab,
                onSelectTab = { selectedTab = it },
            )
            Box(modifier = Modifier.weight(1f).fillMaxHeight()) {
                DashboardDestinationContent(
                    selectedTab = selectedTab,
                    settings = settings,
                    selectedMessagesTab = selectedMessagesTab,
                    onSelectMessagesTab = { selectedMessagesTab = it },
                    navigationRequest = navigationRequest,
                    selectedSettingsTab = selectedSettingsTab,
                    onSelectSettingsTab = { selectedSettingsTab = it },
                )
            }
        }
        return
    }

    Scaffold(
        modifier = modifier
            .fillMaxSize()
            .statusBarsPadding(),
        bottomBar = {
            DashboardNavigationBar(
                tabs = tabs,
                selectedTab = selectedTab,
                onSelectTab = { selectedTab = it },
            )
        },
    ) { innerPadding ->
        Box(modifier = Modifier.fillMaxSize().padding(innerPadding)) {
            DashboardDestinationContent(
                selectedTab = selectedTab,
                settings = settings,
                selectedMessagesTab = selectedMessagesTab,
                onSelectMessagesTab = { selectedMessagesTab = it },
                navigationRequest = navigationRequest,
                selectedSettingsTab = selectedSettingsTab,
                onSelectSettingsTab = { selectedSettingsTab = it },
            )
        }
    }
}

@Composable
private fun DashboardNavigationBar(
    tabs: List<NavItem>,
    selectedTab: Int,
    onSelectTab: (Int) -> Unit,
) {
    NavigationBar(
        containerColor = MaterialTheme.colorScheme.surface,
        tonalElevation = 0.dp,
    ) {
        tabs.forEachIndexed { index, item ->
            NavigationBarItem(
                selected = selectedTab == index,
                onClick = { onSelectTab(index) },
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = MaterialTheme.colorScheme.primary,
                    selectedTextColor = MaterialTheme.colorScheme.primary,
                    unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                    unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
                    indicatorColor = MaterialTheme.colorScheme.primaryContainer,
                ),
                icon = {
                    DashboardNavIcon(
                        item = item,
                        selected = selectedTab == index,
                    )
                },
                label = { Text(item.title) },
            )
        }
    }
}

@Composable
private fun DashboardNavigationRail(
    tabs: List<NavItem>,
    selectedTab: Int,
    onSelectTab: (Int) -> Unit,
) {
    NavigationRail(
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        tabs.forEachIndexed { index, item ->
            NavigationRailItem(
                selected = selectedTab == index,
                onClick = { onSelectTab(index) },
                alwaysShowLabel = true,
                colors = NavigationRailItemDefaults.colors(
                    selectedIconColor = MaterialTheme.colorScheme.primary,
                    selectedTextColor = MaterialTheme.colorScheme.primary,
                    unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                    unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
                    indicatorColor = MaterialTheme.colorScheme.primaryContainer,
                ),
                icon = {
                    DashboardNavIcon(
                        item = item,
                        selected = selectedTab == index,
                    )
                },
                label = { Text(item.title) },
            )
        }
    }
}

@Composable
private fun DashboardNavIcon(item: NavItem, selected: Boolean) {
    InitialBadge(
        text = item.glyph,
        tone = if (selected) DashboardTone.Info else DashboardTone.Neutral,
    )
}

@Composable
private fun DashboardDestinationContent(
    selectedTab: Int,
    settings: SettingsStore,
    selectedMessagesTab: Int,
    onSelectMessagesTab: (Int) -> Unit,
    navigationRequest: DashboardNavigationRequest?,
    selectedSettingsTab: Int,
    onSelectSettingsTab: (Int) -> Unit,
) {
    when (selectedTab) {
        0 -> OverviewScreen(settings)
        1 -> MessagesHubScreen(
            settings = settings,
            selectedIndex = selectedMessagesTab,
            onSelectedIndexChange = onSelectMessagesTab,
            initialPrivateViewerId = navigationRequest?.viewerId,
            initialPrivateSelectionNonce = navigationRequest?.requestId ?: 0L,
        )
        2 -> SettingsHubScreen(
            settings = settings,
            selectedIndex = selectedSettingsTab,
            onSelectedIndexChange = onSelectSettingsTab,
        )
    }
}

private data class NavItem(
    val title: String,
    val glyph: String,
)

private data class DashboardNavigationRequest(
    val destination: String,
    val messagesSection: String,
    val viewerId: String,
    val requestId: Long,
) {
    companion object {
        fun from(intent: android.content.Intent?): DashboardNavigationRequest? {
            val destination = intent?.getStringExtra(MessageSocketManager.EXTRA_DESTINATION).orEmpty()
            if (destination != MessageSocketManager.DESTINATION_MESSAGES) return null
            val section = intent?.getStringExtra(MessageSocketManager.EXTRA_MESSAGES_SECTION)
                ?: MessageSocketManager.MESSAGES_SECTION_PRIVATE
            val viewerId = intent?.getStringExtra(MessageSocketManager.EXTRA_VIEWER_ID).orEmpty()
            return DashboardNavigationRequest(destination, section, viewerId, System.nanoTime())
        }
    }
}
