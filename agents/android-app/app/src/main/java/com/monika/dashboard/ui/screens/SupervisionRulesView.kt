package com.monika.dashboard.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.monika.dashboard.network.SupervisionRules
import com.monika.dashboard.ui.theme.TextMuted

@Composable
fun SupervisionRulesView(rules: SupervisionRules) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = "当前规则",
            style = MaterialTheme.typography.labelLarge,
            color = TextMuted,
        )
        if (rules.reason.isNotBlank()) {
            Text(
                text = rules.reason,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
        SupervisionRuleLine("目标", rules.targetAppRegex)
        SupervisionRuleLine("偏离", rules.blacklistAppRegex)
        SupervisionRuleLine("放行", rules.whitelistAppRegex)
    }
}

@Composable
private fun SupervisionRuleLine(label: String, values: List<String>) {
    if (values.isEmpty()) return
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = TextMuted,
        )
        Text(
            text = values.joinToString("   "),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}
