package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoSessionSettings

/** Runs the listener control test (see NetworkControl) in its own GeckoSession on a 127.0.0.1 page. */
class NetworkControlRunner(private val context: Context) {
    suspend fun run(fixture: String = "network-control", windowMs: Int = 3_000, otherTabFixture: String? = null): ControlResult = withContext(Dispatchers.Main) {
        val server = LoopbackFixtureServer { name -> runCatching { context.assets.open(name).bufferedReader().use { it.readText() } }.getOrNull() }
        val session = GeckoSession(GeckoSessionSettings.Builder().build())
        val channel = CollectorChannel(session, fixtureMode = true)
        // Optional second tab (tests only): its requests must never count as this tab's.
        val other = otherTabFixture?.let { GeckoSession(GeckoSessionSettings.Builder().build()) }
        try {
            channel.attach(GeckoHost.collectorExtension(context))
            session.open(GeckoHost.runtime(context))
            session.setActive(true)
            session.loadUri(server.url("/groups/$FIXTURE_GROUP_ID/", fixture))
            if (!channel.awaitPort(30_000)) return@withContext ControlResult(ControlStatus.TIMEOUT, emptyMap())
            other?.let {
                it.open(GeckoHost.runtime(context))
                it.setActive(true)
                it.loadUri(server.url("/groups/$FIXTURE_GROUP_ID/", otherTabFixture!!))
            }
            delay(800)
            val counts = channel.networkControl(windowMs)
            ControlResult(NetworkControl.classify(counts), counts.orEmpty())
        } finally {
            channel.close()
            runCatching { other?.close() }
            runCatching { session.setActive(false) }
            runCatching { session.close() }
            server.close()
        }
    }
}
