package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import android.graphics.PixelFormat
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.mozilla.geckoview.GeckoDisplay
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoSessionSettings
import java.util.UUID

/** How the fixture session is drawn: not at all, or into an invisible off-screen buffer. */
enum class SurfaceMode { NONE, OFFSCREEN }

/**
 * One scan of a LOCAL fixture page in a GeckoSession that is not shown on
 * screen. Shared by the instrumented tests and the screen-off test service,
 * so both exercise the same path: built-in extension → port →
 * collector-core.js → validated report.
 *
 * [SurfaceMode.NONE]: no surface at all, as a plain background service.
 * [SurfaceMode.OFFSCREEN]: GeckoView's official GeckoDisplay API renders into
 * an ImageReader buffer nobody sees, so layout, requestAnimationFrame and
 * IntersectionObserver have a viewport. Nothing is captured or kept.
 * [attach]/[detach] let a test show the session in a real GeckoView instead.
 */
class HeadlessFixtureScan(private val context: Context) {

    data class Result(val report: ScanReport, val portConnected: Boolean, val userAgent: String?)

    suspend fun run(
        path: String,
        fixture: String,
        scrolls: Int = 0,
        scrollPauseMs: Int = 1500,
        portTimeoutMs: Long = 30_000,
        surface: SurfaceMode = SurfaceMode.NONE,
        attach: ((GeckoSession) -> Unit)? = null,
        detach: (() -> Unit)? = null,
        /** Test-only verified aliases of the fixture group; the app itself uses PocPolicy.VERIFIED_ALIASES. */
        aliases: List<String> = emptyList(),
    ): Result = withContext(Dispatchers.Main) {
        val server = LoopbackFixtureServer { name -> runCatching { context.assets.open(name).bufferedReader().use { it.readText() } }.getOrNull() }
        // Not private mode: built-in extensions are not enabled in private browsing by default.
        val session = GeckoSession(GeckoSessionSettings.Builder().build())
        val channel = CollectorChannel(session, fixtureMode = true)
        var offscreen: OffscreenSurface? = null
        try {
            val extension = GeckoHost.collectorExtension(context)
            channel.attach(extension)
            session.open(GeckoHost.runtime(context))
            when {
                attach != null -> attach(session)
                surface == SurfaceMode.OFFSCREEN -> offscreen = OffscreenSurface(session)
            }
            // Without a view the session would be treated as a background tab; keep it active, as a scan service would.
            session.setActive(true)
            val userAgent = runCatching { session.userAgent.await() }.getOrNull()
            session.loadUri(server.url(path, fixture))
            val connected = channel.awaitPort(portTimeoutMs)
            val report = if (!connected) ScanProtocol.failure(ScanStatus.NOT_READY, "Rozszerzenie nie połączyło się w ${portTimeoutMs / 1000} s")
            else channel.scan(ScanRequest(nonce = UUID.randomUUID().toString(), groupId = FIXTURE_GROUP_ID, scrolls = scrolls, scrollPauseMs = scrollPauseMs, allowLoopback = true, aliases = aliases))
            Result(report, connected, userAgent)
        } finally {
            channel.close()
            runCatching { detach?.invoke() }
            runCatching { offscreen?.release() }
            runCatching { session.setActive(false) }
            runCatching { session.close() }
            server.close()
        }
    }

    /** A phone-sized invisible render target; frames are dropped as soon as they arrive. */
    private class OffscreenSurface(private val session: GeckoSession, width: Int = 1080, height: Int = 2340) {
        private val thread = HandlerThread("gecko-poc-offscreen").apply { start() }
        // Gecko's compositor produces RGBX_8888 buffers; a mismatched reader format throws on acquire.
        private val reader = ImageReader.newInstance(width, height, PixelFormat.RGBX_8888, 2).apply {
            setOnImageAvailableListener({ reader -> runCatching { reader.acquireLatestImage()?.close() } }, Handler(thread.looper))
        }
        private val display: GeckoDisplay = session.acquireDisplay().apply {
            surfaceChanged(GeckoDisplay.SurfaceInfo.Builder(reader.surface).size(width, height).build())
        }

        fun release() {
            runCatching { display.surfaceDestroyed() }
            runCatching { session.releaseDisplay(display) }
            reader.close()
            thread.quitSafely()
        }
    }
}
