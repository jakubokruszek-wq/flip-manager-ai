package pl.jakubokruszek.flipcollector

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Rule
import org.junit.Test
import pl.jakubokruszek.flipcollector.watcher.android.LivePilotActivity

class LivePilotUiTest {
    @get:Rule val screen = createAndroidComposeRule<LivePilotActivity>()
    @Test fun defaultBuildCannotOpenFacebookOrStartPilot() {
        screen.onNodeWithText("Otwórz sesję za zgodą").performScrollTo().assertIsNotEnabled()
        screen.onNodeWithText("Skanuj raz — maks. 20").performScrollTo().assertIsNotEnabled()
    }
    @Test fun pilotShowsOnlySanitizedWebViewStatus() {
        screen.onNodeWithText("Diagnostyka WebView (bez adresów i danych logowania): NOT_OPENED")
            .performScrollTo().assertExists()
        screen.onNodeWithText("Zablokowane zasoby strony: 0").performScrollTo().assertExists()
    }

    @Test fun stopIsVisibleAndReportsOperatorRequest() {
        screen.onNodeWithText("STOP", substring = false).performScrollTo().performClick()
        screen.onNodeWithText("STOP na żądanie operatora").performScrollTo().assertIsDisplayed()
    }
}
