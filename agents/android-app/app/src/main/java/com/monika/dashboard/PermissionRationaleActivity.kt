package com.monika.dashboard

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.monika.dashboard.ui.components.DashboardCard
import com.monika.dashboard.ui.components.ScreenHeader
import com.monika.dashboard.ui.theme.DashboardTheme

class PermissionRationaleActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            DashboardTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(20.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        ScreenHeader(
                            title = "健康权限",
                            subtitle = "这些权限只用于同步你明确选择的 Health Connect 记录。",
                        )
                        DashboardCard {
                            Text(
                                text = "Monika Now 会读取你授权的心率、步数、睡眠等健康记录，并上传到你配置的私人服务器。",
                                style = MaterialTheme.typography.bodyLarge,
                            )
                            Text(
                                text = "你可以在应用内选择要同步的数据类型，也可以随时在 Health Connect 中撤销权限。",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}
