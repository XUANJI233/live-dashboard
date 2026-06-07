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

val Canvas = Color(0xFFFBFAF7)
val Card = Color(0xFFFFFFFF)
val SurfaceMuted = Color(0xFFF4F1EC)
val Border = Color(0xFFE7E1D8)
val Primary = Color(0xFF2B2926)
val Secondary = Color(0xFF5D766F)
val Accent = Color(0xFFA65F3D)
val AccentBlue = Color(0xFFE5F1F7)
val AccentGreen = Color(0xFFEAF1E7)
val AccentYellow = Color(0xFFF7EED8)
val AccentRed = Color(0xFFF8E7E5)
val TextMain = Color(0xFF2B2926)
val TextMuted = Color(0xFF77716A)

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
    primaryContainer = Color(0xFFECE6DD),
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
        color = TextMain
    ),
    headlineMedium = TextStyle(
        fontWeight = FontWeight.SemiBold,
        fontSize = 22.sp,
        color = TextMain
    ),
    titleLarge = TextStyle(
        fontWeight = FontWeight.SemiBold,
        fontSize = 20.sp,
        color = TextMain
    ),
    titleMedium = TextStyle(
        fontWeight = FontWeight.SemiBold,
        fontSize = 16.sp,
        color = TextMain
    ),
    titleSmall = TextStyle(
        fontWeight = FontWeight.SemiBold,
        fontSize = 14.sp,
        color = TextMain
    ),
    bodyLarge = TextStyle(
        fontSize = 16.sp,
        color = TextMain
    ),
    bodyMedium = TextStyle(
        fontSize = 14.sp,
        color = TextMain
    ),
    bodySmall = TextStyle(
        fontSize = 12.sp,
        color = TextMuted
    ),
    labelLarge = TextStyle(
        fontWeight = FontWeight.SemiBold,
        fontSize = 14.sp,
        fontFamily = FontFamily.Monospace,
        color = TextMain
    ),
    labelSmall = TextStyle(
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        fontFamily = FontFamily.Monospace,
        color = TextMuted
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
