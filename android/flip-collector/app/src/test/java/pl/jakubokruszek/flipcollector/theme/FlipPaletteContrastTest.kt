package pl.jakubokruszek.flipcollector.theme

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WCAG 2.x contrast of every text/background pair the screens use, in both
 * palettes: 4.5:1 for body text, 3:1 for large text, icons, outlines and
 * component boundaries. A palette change that breaks readability fails here.
 */
class FlipPaletteContrastTest {
    private val palettes = listOf(FlipPalette.LIGHT, FlipPalette.DARK)

    private fun assertContrast(name: String, palette: FlipPalette, fg: Long, bg: Long, minimum: Double) {
        val ratio = FlipPalette.contrast(fg, bg)
        assertTrue("${if (palette.isDark) "DARK" else "LIGHT"} $name: %.2f < $minimum".format(ratio), ratio >= minimum)
    }

    @Test
    fun luminanceAndContrastMatchTheWcagReferenceValues() {
        assertEquals(21.0, FlipPalette.contrast(0xFF000000, 0xFFFFFFFF), 0.01)
        assertEquals(1.0, FlipPalette.contrast(0xFF777777, 0xFF777777), 0.001)
        // #767676 on white is the classic 4.54:1 boundary colour.
        assertEquals(4.54, FlipPalette.contrast(0xFF767676, 0xFFFFFFFF), 0.01)
    }

    @Test
    fun bodyTextIsAtLeast4_5To1OnEverySurface() {
        for (p in palettes) {
            for ((surfaceName, surface) in listOf("background" to p.background, "surface" to p.surface, "surfaceMuted" to p.surfaceMuted)) {
                assertContrast("foreground/$surfaceName", p, p.foreground, surface, 4.5)
                assertContrast("mutedForeground/$surfaceName", p, p.mutedForeground, surface, 4.5)
                assertContrast("goldText/$surfaceName", p, p.goldText, surface, 4.5)
                assertContrast("success/$surfaceName", p, p.success, surface, 4.5)
                assertContrast("warning/$surfaceName", p, p.warning, surface, 4.5)
                assertContrast("danger/$surfaceName", p, p.danger, surface, 4.5)
            }
            assertContrast("foreground/surfaceHover", p, p.foreground, p.surfaceHover, 4.5)
        }
    }

    @Test
    fun textOnFilledButtonsIsAtLeast4_5To1() {
        for (p in palettes) {
            assertContrast("onGold/gold", p, p.onGold, p.gold, 4.5)
            assertContrast("onDanger/danger", p, p.onDanger, p.danger, 4.5)
        }
    }

    @Test
    fun outlinesAndIndicatorsAreAtLeast3To1() {
        for (p in palettes) {
            assertContrast("goldBorder/surface", p, p.goldBorder, p.surface, 3.0)
            assertContrast("mutedForeground (field outline)/surface", p, p.mutedForeground, p.surface, 3.0)
        }
        // The gold fill itself is a boundary on the dark theme only; on light it always carries graphite text.
        assertContrast("gold/surface", FlipPalette.DARK, FlipPalette.DARK.gold, FlipPalette.DARK.surface, 3.0)
    }

    @Test
    fun lightIsTheDefaultAndSystemFollowsThePhone() {
        assertEquals(ThemeMode.LIGHT, ThemeMode.parse(null))
        assertEquals(ThemeMode.LIGHT, ThemeMode.parse("nonsense"))
        assertEquals(FlipPalette.LIGHT, ThemeMode.LIGHT.palette(systemDark = true))
        assertEquals(FlipPalette.DARK, ThemeMode.DARK.palette(systemDark = false))
        assertEquals(FlipPalette.DARK, ThemeMode.SYSTEM.palette(systemDark = true))
        assertEquals(FlipPalette.LIGHT, ThemeMode.SYSTEM.palette(systemDark = false))
        assertFalse(FlipPalette.LIGHT.isDark)
    }

    @Test
    fun lightThemeUsesGraphiteTextOnALightBackground() {
        assertTrue(FlipPalette.luminance(FlipPalette.LIGHT.background) > 0.85)
        assertTrue(FlipPalette.luminance(FlipPalette.LIGHT.foreground) < 0.05)
    }
}
