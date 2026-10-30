package pl.jakubokruszek.flipwatcher.geckopoc

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.mozilla.geckoview.GeckoSession
import java.util.UUID

/**
 * Runs one "Zmierz otwarcie grupy": arms the background BEFORE loadUri,
 * loads the approved group, waits the window (aborting if the session goes
 * away), reads the counts once and asks the new page for DOM counts.
 * The background measurement is aborted/cleared on every failure path.
 */
class LoadMeasurementRunner(private val background: BackgroundChannel) {
    suspend fun run(
        session: GeckoSession,
        channel: CollectorChannel,
        url: String,
        groupId: String,
        windowMs: Int = LoadMeasurement.WINDOW_MS,
        allowLoopback: Boolean = false,
        sessionAlive: () -> Boolean = { true },
    ): LoadResult = withContext(Dispatchers.Main) {
        if (!background.isConnected && !background.awaitPort(3_000)) return@withContext LoadMeasurement.status(false, null, null, "BACKGROUND_NOT_CONNECTED")
        val nonce = UUID.randomUUID().toString()
        var armed = false
        try {
            armed = LoadMeasurement.parseArmed(background.request(LoadMeasurement.armRequest(nonce, groupId, windowMs)), nonce)
            if (!armed) return@withContext LoadMeasurement.status(false, null, null)
            session.loadUri(url)
            var waited = 0
            while (waited < windowMs) {
                if (!sessionAlive()) {
                    background.request(LoadMeasurement.abortRequest(nonce), 1_000)
                    return@withContext LoadMeasurement.status(true, null, null, "SESSION_CLOSED")
                }
                delay(250)
                waited += 250
            }
            val read = LoadMeasurement.parseRead(background.request(LoadMeasurement.readRequest(nonce)), nonce)
            val dom = if (sessionAlive() && channel.awaitPort(3_000)) channel.loadDomStats(groupId, allowLoopback) else null
            LoadMeasurement.status(true, read, dom)
        } catch (e: CancellationException) {
            withContext(NonCancellable) { runCatching { background.request(LoadMeasurement.abortRequest(nonce), 1_000) } }
            throw e
        } catch (e: Exception) {
            runCatching { background.request(LoadMeasurement.abortRequest(nonce), 1_000) }
            LoadMeasurement.status(armed, null, null, "ERROR_" + e.javaClass.simpleName.take(30))
        }
    }
}
