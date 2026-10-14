package pl.jakubokruszek.flipcollector.ui

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** Colours of the Flip Manager web app (app/globals.css), so the phone app reads as the same product. */
object FlipColors {
    val Surface = Color(0xFF0B0D0F)
    val SurfaceElevated = Color(0xFF15191E)
    val SurfaceMuted = Color(0xFF1B2026)
    val SurfaceHover = Color(0xFF20262D)
    val Border = Color(0x14F4F1EA)
    val Foreground = Color(0xFFF4F1EA)
    val MutedForeground = Color(0xFFA7ABB1)
    val Gold = Color(0xFFD6B35A)
    val GoldMuted = Color(0xFF8F7331)
    val OnGold = Color(0xFF17130A)
    val Success = Color(0xFF69A982)
    val Warning = Color(0xFFD7A652)
    val Danger = Color(0xFFC96C6C)
}

private val scheme = darkColorScheme(
    primary = FlipColors.Gold,
    onPrimary = FlipColors.OnGold,
    primaryContainer = FlipColors.GoldMuted,
    onPrimaryContainer = FlipColors.Foreground,
    secondary = FlipColors.SurfaceHover,
    onSecondary = FlipColors.Foreground,
    secondaryContainer = FlipColors.SurfaceHover,
    onSecondaryContainer = FlipColors.Gold,
    background = FlipColors.Surface,
    onBackground = FlipColors.Foreground,
    surface = FlipColors.Surface,
    onSurface = FlipColors.Foreground,
    surfaceVariant = FlipColors.SurfaceMuted,
    onSurfaceVariant = FlipColors.MutedForeground,
    surfaceContainer = FlipColors.SurfaceElevated,
    surfaceContainerHigh = FlipColors.SurfaceMuted,
    surfaceContainerHighest = FlipColors.SurfaceHover,
    surfaceContainerLow = FlipColors.SurfaceElevated,
    surfaceContainerLowest = FlipColors.Surface,
    outline = FlipColors.GoldMuted,
    outlineVariant = FlipColors.Border,
    error = FlipColors.Danger,
    onError = FlipColors.Foreground,
)

private val shapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(18.dp),
    large = RoundedCornerShape(18.dp),
    extraLarge = RoundedCornerShape(24.dp),
)

@Composable
fun FlipTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, shapes = shapes, content = content)
}
