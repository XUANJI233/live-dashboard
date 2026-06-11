package com.monika.dashboard.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

val Canvas = Color(0xFFF5F5F7)
val Card = Color(0xFFFFFFFF)
val SurfaceMuted = Color(0xFFF2F2F7)
val Border = Color(0xFFE5E5EA)
val Primary = Color(0xFF1D1D1F)
val Secondary = Color(0xFF6E6E73)
val Accent = Color(0xFF007AFF)
val AccentBlue = Color(0xFFEAF4FF)
val AccentGreen = Color(0xFFEAF7EE)
val AccentYellow = Color(0xFFFFF4E5)
val AccentRed = Color(0xFFFDECEC)
val TextMain = Color(0xFF1D1D1F)
val TextMuted = Color(0xFF6E6E73)

private val DashboardColorScheme = lightColorScheme(
    primary = Primary,
    secondary = Secondary,
    tertiary = Accent,
    background = Canvas,
    surface = Card,
    onPrimary = Color.White,
    onSecondary = Color.White,
    onTertiary = Color.White,
    onBackground = TextMain,
    onSurface = TextMain,
    outline = Border,
    surfaceVariant = SurfaceMuted,
    onSurfaceVariant = TextMuted,
    primaryContainer = AccentBlue,
    onPrimaryContainer = TextMain,
    secondaryContainer = AccentGreen,
    onSecondaryContainer = Color(0xFF346538),
    tertiaryContainer = AccentYellow,
    onTertiaryContainer = Color(0xFF7A5600),
    error = Color(0xFF9F2F2D),
    errorContainer = AccentRed,
    onErrorContainer = Color(0xFF9F2F2D),
)

private val DashboardTypography = Typography(
    headlineLarge = TextStyle(
        fontWeight = FontWeight.SemiBold,
        fontSize = 28.sp,
        lineHeight = 34.sp,
    ),
    headlineMedium = TextStyle(
        fontWeight = FontWeight.SemiBold,
        fontSize = 22.sp,
        lineHeight = 28.sp,
    ),
    titleLarge = TextStyle(
        fontWeight = FontWeight.SemiBold,
        fontSize = 20.sp,
        lineHeight = 26.sp,
    ),
    titleMedium = TextStyle(
        fontWeight = FontWeight.SemiBold,
        fontSize = 16.sp,
        lineHeight = 22.sp,
    ),
    titleSmall = TextStyle(
        fontWeight = FontWeight.SemiBold,
        fontSize = 14.sp,
        lineHeight = 19.sp,
    ),
    bodyLarge = TextStyle(
        fontSize = 16.sp,
        lineHeight = 24.sp,
    ),
    bodyMedium = TextStyle(
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
    bodySmall = TextStyle(
        fontSize = 12.sp,
        lineHeight = 17.sp,
    ),
    labelLarge = TextStyle(
        fontWeight = FontWeight.SemiBold,
        fontSize = 14.sp,
        lineHeight = 18.sp,
        fontFamily = FontFamily.Monospace
    ),
    labelSmall = TextStyle(
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 15.sp,
        fontFamily = FontFamily.Monospace
    )
)

@Composable
fun DashboardTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = DashboardColorScheme,
        typography = DashboardTypography,
        content = content
    )
}
