package pl.jakubokruszek.flipwatcher.geckopoc

import kotlinx.coroutines.delay
import org.json.JSONObject
import org.mozilla.geckoview.GeckoSession

/** New consent, same approved session/tab, one exact reload. No collector or saved results. */
class ResponseLoadRunner(private val background: BackgroundChannel) {
    suspend fun run(session: GeckoSession, channel: CollectorChannel, url: String, groupId: String,
        windowMs: Int = 25_000, autoScrollConsent: Boolean = false, beaconConsent: Boolean = false, fastScrollConsent: Boolean = false, alive: () -> Boolean, willLoad: () -> Unit): String? {
        val wait = windowMs.coerceIn(1_000, 25_000)
        val deadline = android.os.SystemClock.elapsedRealtime() + wait
        var finished = false
        val nonce = java.util.UUID.randomUUID().toString()
        try {
            if (!background.isConnected && !background.awaitPort(3_000)) return null
            channel.prepareResponseLoad(true, groupId, wait, nonce, autoScrollConsent, beaconConsent, fastScrollConsent) ?: return null
            if (!alive() || android.os.SystemClock.elapsedRealtime() >= deadline) return null
            willLoad(); session.loadUri(url)
            while (android.os.SystemClock.elapsedRealtime() < deadline) { if (!alive()) return null; delay(250) }
            if (!alive()) return null
            val reply = background.request(JSONObject().put("type", "readResponseLoad").put("nonce", nonce)) ?: return null
            val report = ResponseProtocol.report(reply, nonce)
            finished = true
            return report
        } finally { if (!finished) background.abortResponseLoad(nonce) }
    }
}
