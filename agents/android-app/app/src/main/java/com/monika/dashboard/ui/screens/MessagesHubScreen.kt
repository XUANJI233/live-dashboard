package com.monika.dashboard.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.monika.dashboard.data.SettingsStore
import com.monika.dashboard.ui.components.CompactPageHeader
import com.monika.dashboard.ui.components.SegmentedControl

@Composable
fun MessagesHubScreen(
    settings: SettingsStore,
    selectedIndex: Int? = null,
    onSelectedIndexChange: ((Int) -> Unit)? = null,
) {
    var localSelected by rememberSaveable { mutableIntStateOf(0) }
    val selected = selectedIndex ?: localSelected
    val selectTab: (Int) -> Unit = {
        if (onSelectedIndexChange != null) {
            onSelectedIndexChange(it)
        } else {
            localSelected = it
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 16.dp, top = 8.dp, end = 16.dp, bottom = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            CompactPageHeader(
                title = "消息",
                subtitle = "私聊和公开留言板集中处理。",
            )
            SegmentedControl(
                options = listOf("私聊", "公开留言"),
                selectedIndex = selected,
                onSelect = selectTab,
            )
        }

        Box(modifier = Modifier.weight(1f)) {
            if (selected == 0) {
                MessagesScreen(settings = settings, showHeader = false)
            } else {
                BoardScreen(settings = settings, showHeader = false)
            }
        }
    }
}
