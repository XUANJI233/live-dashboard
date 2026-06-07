@file:Suppress("MatchingDeclarationName")

package com.monika.dashboard.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.monika.dashboard.ui.theme.AccentBlue
import com.monika.dashboard.ui.theme.AccentGreen
import com.monika.dashboard.ui.theme.AccentRed
import com.monika.dashboard.ui.theme.AccentYellow
import com.monika.dashboard.ui.theme.Border
import com.monika.dashboard.ui.theme.SurfaceMuted
import com.monika.dashboard.ui.theme.TextMuted

enum class DashboardTone {
    Neutral,
    Good,
    Warn,
    Bad,
    Info,
}

@Composable
fun DashboardCard(
    modifier: Modifier = Modifier,
    tone: DashboardTone = DashboardTone.Neutral,
    contentPadding: Dp = 16.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(12.dp),
        color = tone.surfaceColor(),
        border = BorderStroke(1.dp, Border),
    ) {
        Column(
            modifier = Modifier.padding(contentPadding),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            content = content,
        )
    }
}

@Composable
fun ScreenHeader(
    title: String,
    subtitle: String,
    modifier: Modifier = Modifier,
    meta: String? = null,
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.Top,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.headlineLarge,
                    color = MaterialTheme.colorScheme.onBackground,
                )
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = TextMuted,
                )
            }
            if (!meta.isNullOrBlank()) {
                Spacer(modifier = Modifier.width(12.dp))
                StatusPill(text = meta, tone = DashboardTone.Info)
            }
        }
    }
}

@Composable
fun SectionTitle(
    title: String,
    modifier: Modifier = Modifier,
    meta: String? = null,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onSurface,
        )
        if (!meta.isNullOrBlank()) {
            Text(
                text = meta,
                style = MaterialTheme.typography.labelSmall,
                color = TextMuted,
            )
        }
    }
}

@Composable
fun StatusPill(
    text: String,
    modifier: Modifier = Modifier,
    tone: DashboardTone = DashboardTone.Neutral,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(999.dp),
        color = tone.surfaceColor(),
        border = BorderStroke(1.dp, Border),
    ) {
        Text(
            text = text,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
            style = MaterialTheme.typography.labelSmall,
            color = tone.contentColor(),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
fun InitialBadge(
    text: String,
    modifier: Modifier = Modifier,
    tone: DashboardTone = DashboardTone.Neutral,
) {
    Box(
        modifier = modifier
            .size(34.dp)
            .background(tone.surfaceColor(), RoundedCornerShape(9.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text.take(3).uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = tone.contentColor(),
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

@Composable
fun EmptyState(
    title: String,
    body: String,
    modifier: Modifier = Modifier,
) {
    DashboardCard(modifier = modifier.fillMaxWidth(), tone = DashboardTone.Neutral) {
        Text(text = title, style = MaterialTheme.typography.titleMedium)
        Text(text = body, style = MaterialTheme.typography.bodySmall, color = TextMuted)
    }
}

@Composable
fun MetricTile(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    tone: DashboardTone = DashboardTone.Neutral,
) {
    DashboardCard(modifier = modifier, tone = tone, contentPadding = 12.dp) {
        Text(text = label, style = MaterialTheme.typography.labelSmall, color = TextMuted)
        Text(text = value, style = MaterialTheme.typography.titleLarge)
    }
}

@Composable
fun PrimaryActionColors() = ButtonDefaults.buttonColors(
    containerColor = MaterialTheme.colorScheme.primary,
    contentColor = Color.White,
)

@Composable
fun DashboardTone.surfaceColor(): Color = when (this) {
    DashboardTone.Neutral -> MaterialTheme.colorScheme.surface
    DashboardTone.Good -> AccentGreen
    DashboardTone.Warn -> AccentYellow
    DashboardTone.Bad -> AccentRed
    DashboardTone.Info -> AccentBlue
}

@Composable
fun DashboardTone.contentColor(): Color = when (this) {
    DashboardTone.Neutral -> MaterialTheme.colorScheme.onSurface
    DashboardTone.Good -> Color(0xFF346538)
    DashboardTone.Warn -> Color(0xFF7A5600)
    DashboardTone.Bad -> Color(0xFF9F2F2D)
    DashboardTone.Info -> Color(0xFF1F5F89)
}

@Composable
fun CompactDivider(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(Border),
    )
}

val ListGap = 10.dp
val ScreenPadding = 16.dp
val SurfaceGap = 14.dp
val SurfaceMutedColor: Color
    @Composable get() = SurfaceMuted
