package com.monika.dashboard.ui.components

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.monika.dashboard.system.LsposedConfigBridge
import com.monika.dashboard.ui.theme.TextMuted
import kotlinx.coroutines.delay

private val PAUSE_OPTIONS_MINUTES = listOf(15, 30, 60)
private const val CONFIRM_DELAY_SECONDS = 30

/**
 * Manual escape hatch for the Hermes-managed strict-browsing allowlist: a pause needs
 * a 30-second wait before it can be confirmed, while resuming applies immediately.
 */
@Composable
fun WebAllowlistPauseControl(
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val context = LocalContext.current
    var selectedIndex by rememberSaveable { mutableIntStateOf(1) }
    var countdown by rememberSaveable { mutableIntStateOf(0) }
    var readyMinutes by rememberSaveable { mutableIntStateOf(0) }

    LaunchedEffect(countdown) {
        if (countdown > 0) {
            delay(1000)
            val next = countdown - 1
            countdown = next
            if (next == 0) readyMinutes = PAUSE_OPTIONS_MINUTES[selectedIndex]
        }
    }

    fun send(minutes: Int) {
        val ok = LsposedConfigBridge.pauseWebAllowlist(context.applicationContext, minutes)
        val message = when {
            !ok -> "LSPosed 网站白名单广播发送失败"
            minutes > 0 -> "已请求暂停网站白名单 $minutes 分钟"
            else -> "已请求立即恢复网站白名单"
        }
        Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
    }

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(text = "临时暂停网站白名单", style = MaterialTheme.typography.titleSmall)
        Text(
            text = "白名单由 Hermes 管理，仅特殊情况临时放开；最多 1 小时，到期自动恢复。",
            style = MaterialTheme.typography.bodySmall,
            color = TextMuted,
        )
        SegmentedControl(
            options = PAUSE_OPTIONS_MINUTES.map { "$it 分钟" },
            selectedIndex = selectedIndex,
            onSelect = {
                selectedIndex = it
                countdown = 0
                readyMinutes = 0
            },
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(
                onClick = {
                    if (readyMinutes > 0) {
                        send(readyMinutes)
                        readyMinutes = 0
                    } else {
                        countdown = CONFIRM_DELAY_SECONDS
                    }
                },
                enabled = enabled && countdown == 0,
                modifier = Modifier.weight(1f),
            ) {
                Text(
                    when {
                        countdown > 0 -> "暂停倒计时 ${countdown}s"
                        readyMinutes > 0 -> "确认暂停 $readyMinutes 分钟"
                        else -> "申请暂停"
                    },
                )
            }
            OutlinedButton(
                onClick = {
                    countdown = 0
                    readyMinutes = 0
                    send(0)
                },
                enabled = enabled,
            ) {
                Text("立即恢复")
            }
        }
        CompactDivider()
    }
}
