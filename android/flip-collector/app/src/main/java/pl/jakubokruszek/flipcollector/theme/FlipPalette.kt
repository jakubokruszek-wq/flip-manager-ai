package pl.jakubokruszek.flipcollector.theme

import kotlin.math.pow

/**
 * Colour tokens of the app as ARGB longs, free of Compose so the contrast of
 * every text/background pair can be checked in plain unit tests
 * (FlipPaletteContrastTest). ui/FlipTheme.kt turns them into Compose colours.
 *
 * Light is the default: warm off-white background, graphite text and the
 * Flip Manager gold (#D6B35A) as fill and accent. Gold is too light to be
 * text on white, so text that should read as gold uses [goldText].
 */
data class FlipPalette(
    val isDark: Boolean,
    val background: Long,
    val surface: Long,
    val surfaceMuted: Long,
    val surfaceHover: Long,
    val border: Long,
    val foreground: Long,
    val mutedForeground: Long,
    /** Gold as a fill (buttons, selected chips, switch track, progress). */
    val gold: Long,
    /** Text and icons placed on [gold]. */
    val onGold: Long,
    /** Gold used as text on [surface] / [background]. */
    val goldText: Long,
    /** Outline of highlighted cards and focused fields. */
    val goldBorder: Long,
    val success: Long,
    val warning: Long,
    val danger: Long,
    /** Text on [danger] (filled destructive actions). */
    val onDanger: Long,
) {
    companion object {
        val LIGHT = FlipPalette(
            isDark = false,
            background = 0xFFF7F5F0,
            surface = 0xFFFFFFFF,
            surfaceMuted = 0xFFF1EEE6,
            surfaceHover = 0xFFE6E1D5,
            border = 0xFFDCD5C6,
            foreground = 0xFF1F2328,
            mutedForeground = 0xFF545A63,
            gold = 0xFFD6B35A,
            onGold = 0xFF1F2328,
            goldText = 0xFF755812,
            goldBorder = 0xFFB08D36,
            success = 0xFF2B6A45,
            warning = 0xFF855600,
            danger = 0xFFA83A3A,
            onDanger = 0xFFFFFFFF,
        )

        /** The web app's dark tokens (app/globals.css). */
        val DARK = FlipPalette(
            isDark = true,
            background = 0xFF0B0D0F,
            surface = 0xFF15191E,
            surfaceMuted = 0xFF1B2026,
            surfaceHover = 0xFF20262D,
            border = 0xFF2A3038,
            foreground = 0xFFF4F1EA,
            mutedForeground = 0xFFA7ABB1,
            gold = 0xFFD6B35A,
            onGold = 0xFF17130A,
            goldText = 0xFFE0C276,
            goldBorder = 0xFF8F7331,
            success = 0xFF7DBA95,
            warning = 0xFFE0B263,
            danger = 0xFFE08A8A,
            onDanger = 0xFF17130A,
        )

        /** WCAG 2.x relative luminance of an opaque ARGB colour. */
        fun luminance(argb: Long): Double {
            fun channel(shift: Int): Double {
                val c = ((argb shr shift) and 0xFF).toDouble() / 255.0
                return if (c <= 0.03928) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
            }
            return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
        }

        /** WCAG contrast ratio, 1.0–21.0. */
        fun contrast(a: Long, b: Long): Double {
            val la = luminance(a)
            val lb = luminance(b)
            return (maxOf(la, lb) + 0.05) / (minOf(la, lb) + 0.05)
        }
    }
}

/** Light is the default; System follows the phone's dark-mode setting. */
enum class ThemeMode(val label: String) {
    LIGHT("Jasny"),
    SYSTEM("Systemowy"),
    DARK("Ciemny");

    fun palette(systemDark: Boolean): FlipPalette = when (this) {
        LIGHT -> FlipPalette.LIGHT
        DARK -> FlipPalette.DARK
        SYSTEM -> if (systemDark) FlipPalette.DARK else FlipPalette.LIGHT
    }

    companion object {
        fun parse(value: String?): ThemeMode = entries.firstOrNull { it.name == value } ?: LIGHT
    }
}
