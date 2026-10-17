package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoSessionSettings
import java.util.UUID

/**
 * One scan of a LOCAL fixture page in a GeckoSession that is not attached to
 * any view (no surface, as with the screen off). Shared by the instrumented
 * tests and the screen-off test service, so both exercise the same path:
 * built-in extension → port → collector-core.js → validated report.
 */
class HeadlessFixtureScan(private val context: Context) {

    data class Result(val report: ScanReport, val portConnected: Boolean, val userAgent: String?)

    suspend fun run(path: String, fixture: String, scrolls: Int = 0, scrollPauseMs: Int = 1500, portTimeoutMs: Long = 30_000): Result = withContext(Dispatchers.Main) {
        val server = LoopbackFixtureServer { name -> runCatching { context.assets.open(name).bufferedReader().use { it.readText() } }.getOrNull() }
        // Not private mode: built-in extensions are not enabled in private browsing by default.
        val session = GeckoSession(GeckoSessionSettings.Builder().build())
        val channel = CollectorChannel(session, fixtureMode = true)
        try {
            val extension = GeckoHost.collectorExtension(context)
            channel.attach(extension)
            session.open(GeckoHost.runtime(context))
            // Without a view the session would be treated as a background tab; keep it active, as a scan service would.
            session.setActive(true)
            val userAgent = runCatching { session.userAgent.await() }.getOrNull()
            session.loadUri(server.url(path, fixture))
            val connected = channel.awaitPort(portTimeoutMs)
            val report = if (!connected) ScanProtocol.failure(ScanStatus.NOT_READY, "Rozszerzenie nie połączyło się w ${portTimeoutMs / 1000} s")
            else channel.scan(ScanRequest(nonce = UUID.randomUUID().toString(), groupId = FIXTURE_GROUP_ID, scrolls = scrolls, scrollPauseMs = scrollPauseMs, allowLoopback = true))
            Result(report, connected, userAgent)
        } finally {
            channel.close()
            runCatching { session.setActive(false) }
            runCatching { session.close() }
            server.close()
        }
    }
}
