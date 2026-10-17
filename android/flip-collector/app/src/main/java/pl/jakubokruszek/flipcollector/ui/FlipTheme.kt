package pl.jakubokruszek.flipcollector.ui

import android.content.Context
import android.graphics.Color as AndroidColor
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import pl.jakubokruszek.flipcollector.theme.FlipPalette
import pl.jakubokruszek.flipcollector.theme.ThemeMode

/** Compose view of [FlipPalette]; names kept from the first dark-only version so call sites read the same. */
data class FlipTokens(
    val isDark: Boolean,
    /** Screen background. */
    val Surface: Color,
    /** Cards and bars. */
    val SurfaceElevated: Color,
    val SurfaceMuted: Color,
    val SurfaceHover: Color,
    val Border: Color,
    val Foreground: Color,
    val MutedForeground: Color,
    val Gold: Color,
    val GoldMuted: Color,
    val GoldText: Color,
    val OnGold: Color,
    val Success: Color,
    val Warning: Color,
    val Danger: Color,
    val OnDanger: Color,
)

private fun FlipPalette.tokens() = FlipTokens(
    isDark = isDark,
    Surface = Color(background),
    SurfaceElevated = Color(surface),
    SurfaceMuted = Color(surfaceMuted),
    SurfaceHover = Color(surfaceHover),
    Border = Color(border),
    Foreground = Color(foreground),
    MutedForeground = Color(mutedForeground),
    Gold = Color(gold),
    GoldMuted = Color(goldBorder),
    GoldText = Color(goldText),
    OnGold = Color(onGold),
    Success = Color(success),
    Warning = Color(warning),
    Danger = Color(danger),
    OnDanger = Color(onDanger),
)

val LocalFlipTokens = staticCompositionLocalOf { FlipPalette.LIGHT.tokens() }

/** The current theme's colours: `FlipColors.Foreground`, `FlipColors.Gold`, … */
val FlipColors: FlipTokens
    @Composable @ReadOnlyComposable get() = LocalFlipTokens.current

/** App-wide theme choice, persisted locally. Light by default. */
object ThemeController {
    private const val FILE = "flip_collector_ui"
    private const val KEY = "theme_mode"

    var mode by mutableStateOf(ThemeMode.LIGHT)
        private set

    fun load(context: Context) {
        mode = ThemeMode.parse(context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY, null))
    }

    fun set(context: Context, value: ThemeMode) {
        mode = value
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString(KEY, value.name).apply()
    }
}

private fun FlipPalette.scheme() = if (isDark) {
    darkColorScheme(
        primary = Color(goldText), onPrimary = Color(onGold),
        primaryContainer = Color(gold), onPrimaryContainer = Color(onGold),
        secondary = Color(surfaceHover), onSecondary = Color(foreground),
        secondaryContainer = Color(surfaceHover), onSecondaryContainer = Color(foreground),
        background = Color(background), onBackground = Color(foreground),
        surface = Color(background), onSurface = Color(foreground),
        surfaceVariant = Color(surfaceMuted), onSurfaceVariant = Color(mutedForeground),
        surfaceContainerLowest = Color(background), surfaceContainerLow = Color(surface),
        surfaceContainer = Color(surface), surfaceContainerHigh = Color(surfaceMuted), surfaceContainerHighest = Color(surfaceHover),
        outline = Color(mutedForeground), outlineVariant = Color(border),
        error = Color(danger), onError = Color(onDanger),
    )
} else {
    lightColorScheme(
        // Gold is too light for text on white; primary (focused fields, text
        // buttons, default filled buttons) uses the dark gold.
        primary = Color(goldText), onPrimary = Color(0xFFFFFFFF),
        primaryContainer = Color(gold), onPrimaryContainer = Color(onGold),
        secondary = Color(surfaceHover), onSecondary = Color(foreground),
        secondaryContainer = Color(surfaceHover), onSecondaryContainer = Color(foreground),
        background = Color(background), onBackground = Color(foreground),
        surface = Color(background), onSurface = Color(foreground),
        surfaceVariant = Color(surfaceMuted), onSurfaceVariant = Color(mutedForeground),
        surfaceContainerLowest = Color(surface), surfaceContainerLow = Color(surface),
        surfaceContainer = Color(surface), surfaceContainerHigh = Color(surfaceMuted), surfaceContainerHighest = Color(surfaceHover),
        outline = Color(mutedForeground), outlineVariant = Color(border),
        error = Color(danger), onError = Color(onDanger),
    )
}

private val shapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(18.dp),
    large = RoundedCornerShape(18.dp),
    extraLarge = RoundedCornerShape(24.dp),
)

/**
 * Applies the chosen palette, a [Surface] that sets the default text colour
 * (without it Text falls back to black, unreadable on a dark window), and
 * status/navigation bar icons that match the background.
 */
@Composable
fun FlipTheme(activity: ComponentActivity? = null, content: @Composable () -> Unit) {
    val palette = ThemeController.mode.palette(isSystemInDarkTheme())
    val tokens = palette.tokens()
    if (activity != null) {
        LaunchedEffect(palette.isDark) {
            val style = if (palette.isDark) SystemBarStyle.dark(AndroidColor.TRANSPARENT) else SystemBarStyle.light(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT)
            activity.enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
        }
    }
    CompositionLocalProvider(LocalFlipTokens provides tokens) {
        MaterialTheme(colorScheme = palette.scheme(), shapes = shapes) {
            Surface(Modifier.fillMaxSize(), color = tokens.Surface, contentColor = tokens.Foreground, content = content)
        }
    }
}
