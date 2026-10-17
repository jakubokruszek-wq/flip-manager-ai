package pl.jakubokruszek.flipwatcher.geckopoc

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.WebExtension
import java.util.UUID

/**
 * Native-messaging link between the app and the content script of ONE
 * GeckoSession. The content script opens a port on every page load; the app
 * keeps only the latest trusted one. A page change closes the port, which
 * fails any running scan with PORT_CLOSED — so a scan never continues on
 * another page. All calls on the main thread.
 */
class CollectorChannel(
    private val session: GeckoSession,
    private val fixtureMode: Boolean = false,
    private val onProbe: (PageProbe) -> Unit = {},
) {
    private var port: WebExtension.Port? = null
    private var portReady: CompletableDeferred<Unit> = CompletableDeferred()
    private val pending = HashMap<String, CompletableDeferred<JSONObject?>>()

    /** Messages refused because of their origin; shown in diagnostics. */
    var untrustedPorts = 0
        private set

    val isConnected: Boolean get() = port != null

    private val portDelegate = object : WebExtension.PortDelegate {
        override fun onPortMessage(message: Any, port: WebExtension.Port) {
            if (port !== this@CollectorChannel.port) return
            val json = ScanProtocol.asJson(message) ?: return
            when (json.optString("type")) {
                "ready" -> ScanProtocol.parseProbe(json.optJSONObject("probe"))?.let(onProbe)
                "probeResult", "scanResult" -> {
                    ScanProtocol.parseProbe(json.optJSONObject("probe"))?.let(onProbe)
                    pending.remove(json.optString("nonce"))?.complete(json)
                }
            }
        }

        override fun onDisconnect(port: WebExtension.Port) {
            if (port !== this@CollectorChannel.port) return
            this@CollectorChannel.port = null
            portReady = CompletableDeferred()
            // The page went away: every waiting request ends now.
            pending.values.forEach { it.complete(null) }
            pending.clear()
        }
    }

    private val messageDelegate = object : WebExtension.MessageDelegate {
        override fun onConnect(port: WebExtension.Port) {
            val sender = port.sender
            if (!PocPolicy.isTrustedSender(sender.url, sender.isTopLevel, fixtureMode)) {
                untrustedPorts++
                port.disconnect()
                return
            }
            this@CollectorChannel.port?.let { old -> runCatching { old.disconnect() } }
            this@CollectorChannel.port = port
            port.setDelegate(portDelegate)
            portReady.complete(Unit)
        }

        override fun onMessage(nativeApp: String, message: Any, sender: WebExtension.MessageSender): GeckoResult<Any>? = null
    }

    fun attach(extension: WebExtension) {
        session.webExtensionController.setMessageDelegate(extension, messageDelegate, PocPolicy.NATIVE_APP)
    }

    suspend fun awaitPort(timeoutMs: Long): Boolean = withTimeoutOrNull(timeoutMs) { portReady.await(); true } ?: false

    suspend fun probe(timeoutMs: Long = 5_000): PageProbe? {
        val nonce = UUID.randomUUID().toString()
        val reply = request(nonce, ScanProtocol.probeRequest(nonce), timeoutMs) ?: return null
        return ScanProtocol.parseProbe(reply.optJSONObject("probe"))
    }

    suspend fun scan(request: ScanRequest, timeoutMs: Long = PocPolicy.SCAN_TIMEOUT_MS): ScanReport {
        if (port == null) return ScanProtocol.failure(ScanStatus.NOT_READY, "Brak połączenia z rozszerzeniem na tej stronie")
        val deferred = CompletableDeferred<JSONObject?>()
        pending[request.nonce] = deferred
        val sent = runCatching { port!!.postMessage(request.toJson()) }.isSuccess
        if (!sent) {
            pending.remove(request.nonce)
            return ScanProtocol.failure(ScanStatus.PORT_CLOSED)
        }
        val reply = withTimeoutOrNull(timeoutMs) { deferred.await() }
        pending.remove(request.nonce)
        return when {
            reply != null -> ScanProtocol.parseScanResult(reply, request)
            deferred.isCompleted -> ScanProtocol.failure(ScanStatus.PORT_CLOSED, "Strona zmieniła się w trakcie odczytu")
            else -> ScanProtocol.failure(ScanStatus.TIMEOUT, "Brak odpowiedzi w ${timeoutMs / 1000} s")
        }
    }

    private suspend fun request(nonce: String, message: JSONObject, timeoutMs: Long): JSONObject? {
        val current = port ?: return null
        val deferred = CompletableDeferred<JSONObject?>()
        pending[nonce] = deferred
        if (runCatching { current.postMessage(message) }.isFailure) {
            pending.remove(nonce)
            return null
        }
        return withTimeoutOrNull(timeoutMs) { deferred.await() }.also { pending.remove(nonce) }
    }

    fun close() {
        port?.let { runCatching { it.disconnect() } }
        port = null
        pending.values.forEach { it.complete(null) }
        pending.clear()
    }
}
