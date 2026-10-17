package pl.jakubokruszek.flipwatcher.geckopoc

import android.app.Activity
import android.os.Bundle
import org.mozilla.geckoview.GeckoView

/** Shows a fixture session full-screen, so tests can compare "visible" with headless and off-screen. */
class GeckoTestHostActivity : Activity() {
    lateinit var geckoView: GeckoView
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        geckoView = GeckoView(this)
        setContentView(geckoView)
    }
}
