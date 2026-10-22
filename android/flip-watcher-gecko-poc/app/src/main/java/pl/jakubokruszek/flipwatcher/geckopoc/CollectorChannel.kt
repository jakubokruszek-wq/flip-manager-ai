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
    private val onVisibleStop: () -> Unit = {},
    private val onPageDisconnect: () -> Unit = onVisibleStop,
    private val onPageConnected: () -> Unit = {},
    private val onShareStop: () -> Unit = {},
    private val onDesktopStop: () -> Unit = {},
    private val onProbe: (PageProbe) -> Unit = {},
) {
    private var shareNonce: String? = null
    private var desktopNonce: String? = null
    internal var viewportBridge:DesktopViewportBridge?=null
    private var port: WebExtension.Port? = null
    private var portReady: CompletableDeferred<Unit> = CompletableDeferred()
    private val pending = HashMap<String, CompletableDeferred<JSONObject?>>()

    /** Messages refused because of their origin; shown in diagnostics. */
    var untrustedPorts = 0
        private set

    var connectedUrl: String? = null; private set
    val isConnected: Boolean get() = port != null
    /** Monotonic within this channel: rejects a port from before a native reload. RAM only. */
    var connectionGeneration = 0L; private set

    private val portDelegate = object : WebExtension.PortDelegate {
        override fun onPortMessage(message: Any, port: WebExtension.Port) {
            if (port !== this@CollectorChannel.port) return
            val json = ScanProtocol.asJson(message) ?: return
            when (json.optString("type")) {
                "desktopViewportRequest" -> viewportBridge?.handle(json){ack->if(port===this@CollectorChannel.port)runCatching{port.postMessage(ack)}}
                "desktopPreviewStop" -> if(json.optString("nonce")==desktopNonce)onDesktopStop()
                "shareLinkStop" -> if (json.optString("nonce") == shareNonce) onShareStop()
                "visiblePostsStop" -> onVisibleStop()
                "ready" -> ScanProtocol.parseProbe(json.optJSONObject("probe"))?.let(onProbe)
                "desktopDocumentProof", "desktopArmed", "desktopPreviewResult", "shareLinkContextResult", "mainTransportResult", "responseLoadArmed", "responseDiagnosisResult", "visiblePostsResult", "probeResult", "scanResult", "groupProbeResult", "domDiagnosisResult", "structureDiagnosisResult", "networkControlResult", "loadDomStatsResult" -> {
                    ScanProtocol.parseProbe(json.optJSONObject("probe"))?.let(onProbe)
                    pending.remove(json.optString("nonce"))?.complete(json)
                }
            }
        }

        override fun onDisconnect(port: WebExtension.Port) {
            if (port !== this@CollectorChannel.port) return
            onPageDisconnect()
            this@CollectorChannel.port = null
            connectedUrl = null
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
            connectedUrl = sender.url
            connectionGeneration++
            port.setDelegate(portDelegate)
            portReady.complete(Unit)
            onPageConnected()
        }

        override fun onMessage(nativeApp: String, message: Any, sender: WebExtension.MessageSender): GeckoResult<Any>? = null
    }

    fun attach(extension: WebExtension) {
        session.webExtensionController.setMessageDelegate(extension, messageDelegate, PocPolicy.NATIVE_APP)
    }

    suspend fun awaitPort(timeoutMs: Long): Boolean = withTimeoutOrNull(timeoutMs) { portReady.await(); true } ?: false

    suspend fun desktopDocumentProof(group:String=PocPolicy.APPROVED_GROUP_ID):DesktopDocumentProof? {
        val nonce=UUID.randomUUID().toString()
        val result=request(nonce,JSONObject().put("type","desktopDocumentProofRequest").put("nonce",nonce).put("consent",true).put("groupId",group).put("allowLoopback",fixtureMode),1500)
        return DesktopProtocol.documentProof(result,nonce)
    }
    suspend fun armDesktop(nonce:String,consent:Boolean,group:String=PocPolicy.APPROVED_GROUP_ID,windowMs:Int=60_000):String {
        if(!consent)return "STOP"
        desktopNonce=nonce
        val result=request(nonce,JSONObject().put("type","armDesktopPreview").put("nonce",nonce).put("consent",true).put("desktopConsent",true).put("groupId",group).put("allowLoopback",fixtureMode).put("windowMs",windowMs),5_000)
        return if(result?.optString("type")=="desktopArmed"&&result.optString("nonce")==nonce)result.optString("status").takeIf{it in setOf("ARMED","STOP","BUSY","UNSUPPORTED")}?:"STOP" else "STOP"
    }
    suspend fun desktopPreview(nonce:String,documentAfter:Long,remainingMs:Int,group:String=PocPolicy.APPROVED_GROUP_ID,previous:DesktopDocumentProof?=null):DesktopReply? {
        if(desktopNonce!=nonce||previous==null)return null
        val result=request(nonce,JSONObject().put("type","desktopPreview").put("nonce",nonce).put("consent",true).put("groupId",group).put("allowLoopback",fixtureMode).put("documentAfter",documentAfter).put("remainingMs",remainingMs).put("previousDocumentId",previous.documentId).put("previousTimeOrigin",previous.timeOrigin).put("viewportConsent",viewportBridge!=null).put("photosConsent",viewportBridge!=null),remainingMs.toLong().coerceIn(500,60_000))
        return DesktopProtocol.parse(result,nonce,group)
    }
    fun abortDesktop(){viewportBridge?.close();viewportBridge=null;desktopNonce=null;runCatching{port?.postMessage(JSONObject().put("type","abortDesktopPreview").put("nonce",UUID.randomUUID().toString()))}}

    suspend fun shareLinkProof(expectedUrl: String, consent: Boolean, newDocumentAfter: Long? = null): ShareContextReply {
        if (!consent) return ShareContextReply.ABSENT
        val nonce = UUID.randomUUID().toString(); shareNonce = nonce
        val reply = request(nonce, JSONObject().put("type", "shareLinkContext").put("nonce", nonce).put("consent", true)
            .apply { if (newDocumentAfter != null) put("newDocumentAfter", newDocumentAfter) }.put("expectedUrl", expectedUrl).put("groupId", if (fixtureMode) FIXTURE_GROUP_ID else PocPolicy.APPROVED_GROUP_ID).put("fixture", fixtureMode), 1_500)
        return ShareContextReply.parse(reply, nonce)
    }
    suspend fun shareLinkContext(expectedUrl: String, consent: Boolean, newDocumentAfter: Long? = null): Pair<Boolean, Boolean>? =
        when(shareLinkProof(expectedUrl, consent, newDocumentAfter)) {
            ShareContextReply.UNSAFE -> false to false
            ShareContextReply.LOADING -> true to false
            ShareContextReply.COMPLETE -> true to true
            else -> null
        }
    fun stopShareLinkContext() {
        shareNonce = null
        runCatching { port?.postMessage(JSONObject().put("type", "stopShareLinkContext").put("nonce", UUID.randomUUID().toString())) }
    }

    suspend fun probe(timeoutMs: Long = 5_000): PageProbe? {
        val nonce = UUID.randomUUID().toString()
        val reply = request(nonce, ScanProtocol.probeRequest(nonce), timeoutMs) ?: return null
        return ScanProtocol.parseProbe(reply.optJSONObject("probe"))
    }

    /** Facebook's own identifiers of the shown group (for GroupIdentity); null when the page did not answer. */
    /** Manually refreshed count-only diagnostics. This does not authorize a scan. */
    suspend fun domDiagnosis(timeoutMs: Long = 8_000): DomDiagnosis? {
        val nonce = UUID.randomUUID().toString()
        return ScanProtocol.parseDomDiagnosis(
            request(nonce, ScanProtocol.domDiagnosisRequest(nonce), timeoutMs), nonce)
    }

    /** Count-only structure report of the shown group page. Never a scan; uses no scan permission. */
    suspend fun structureDiagnosis(groupId: String = PocPolicy.APPROVED_GROUP_ID, windowMs: Int = ScanProtocol.DIAGNOSIS_WINDOW_MS): StructureDiagnosis? {
        val nonce = UUID.randomUUID().toString()
        return ScanProtocol.parseStructureDiagnosis(
            request(nonce, ScanProtocol.structureDiagnosisRequest(nonce, groupId, allowLoopback = fixtureMode, windowMs = windowMs), windowMs + 20_000L), nonce)
    }

    /** Listener control test on a loopback page; counters only. */
    suspend fun networkControl(windowMs: Int = 3_000): Map<String, Int>? {
        val nonce = UUID.randomUUID().toString()
        return ScanProtocol.parseNetworkControl(request(nonce, ScanProtocol.networkControlRequest(nonce, windowMs = windowMs), windowMs + 15_000L), nonce)
    }

    /** DOM counts of the page after a load measurement (no text, ids or values). */
    suspend fun loadDomStats(groupId: String, allowLoopback: Boolean, timeoutMs: Long = 8_000): Map<String, Int>? {
        val nonce = UUID.randomUUID().toString()
        val message = JSONObject().put("type", "loadDomStats").put("nonce", nonce).put("groupId", groupId).put("allowLoopback", allowLoopback)
        return LoadMeasurement.parseDomStats(request(nonce, message, timeoutMs), nonce)
    }

    fun abortResponseDiagnosis() {
        runCatching { port?.postMessage(JSONObject().put("type", "abortResponseDiagnosis").put("nonce", UUID.randomUUID().toString())) }
    }

    /** One fresh explicit consent, no scan authorization, count-only result. */
    suspend fun visiblePosts(consent: Boolean, groupId: String = PocPolicy.APPROVED_GROUP_ID): String? {
        if (!consent) return null
        val nonce = UUID.randomUUID().toString()
        val reply = request(nonce, JSONObject().put("type", "visiblePosts").put("nonce", nonce)
            .put("consent", true).put("groupId", groupId)
            .put("allowLoopback", fixtureMode), 8_000) ?: return null
        return VisiblePostsProtocol.report(reply, nonce)
    }

    suspend fun mainTransport(consent: Boolean, groupId: String = PocPolicy.APPROVED_GROUP_ID, windowMs: Int = 20_000, autoScrollConsent: Boolean = false): String? {
        if (!consent) return null
        val wait=windowMs.coerceIn(1_000,20_000)
        val nonce=UUID.randomUUID().toString()
        val reply=request(nonce,JSONObject().put("type","mainTransport").put("nonce",nonce).put("consent",true)
            .put("groupId",groupId).put("windowMs",wait).put("allowLoopback",fixtureMode).put("autoScrollConsent",autoScrollConsent),wait+10_000L) ?: return null
        return MainTransportProtocol.report(reply,nonce)
    }

    suspend fun prepareResponseLoad(consent: Boolean, groupId: String, windowMs: Int, nonce: String = UUID.randomUUID().toString(), autoScrollConsent: Boolean = false, beaconConsent: Boolean = false, fastScrollConsent: Boolean = false, documentConsent: Boolean = false): String? {
        if (!consent || (beaconConsent && !fixtureMode)) return null
        val reply = request(nonce, JSONObject().put("type", "prepareResponseLoad").put("nonce", nonce)
            .put("consent", true).put("reloadConsent", true).put("documentConsent", documentConsent).put("beaconConsent", beaconConsent).put("fastScrollConsent", fastScrollConsent).put("autoScrollConsent", autoScrollConsent).put("groupId", groupId).put("allowLoopback", fixtureMode)
            .put("windowMs", windowMs.coerceIn(1_000, 25_000)), 8_000) ?: return null
        return nonce.takeIf { reply.optString("type") == "responseLoadArmed" && reply.optString("nonce") == nonce &&
            reply.optString("status") == "ARMED" && reply.keys().asSequence().toSet() == setOf("type", "nonce", "status") }
    }

    suspend fun responseDiagnosis(consent: Boolean, groupId: String = PocPolicy.APPROVED_GROUP_ID, windowMs: Int = 15_000, autoScrollConsent: Boolean = false, fastScrollConsent: Boolean = false): String? {
        if (!consent) return null
        val nonce = UUID.randomUUID().toString()
        val reply = request(nonce, JSONObject().put("type", "responseDiagnosis").put("nonce", nonce)
            .put("consent", true).put("groupId", groupId).put("allowLoopback", fixtureMode)
            .put("autoScrollConsent", autoScrollConsent).put("fastScrollConsent", fastScrollConsent).put("windowMs", windowMs.coerceIn(500, 15_000)), windowMs.coerceIn(500, 15_000) + 8_000L) ?: return null
        return ResponseProtocol.report(reply, nonce)
    }

    suspend fun groupProbe(timeoutMs: Long = 10_000): Pair<String?, List<GroupIdHit>>? {
        val nonce = UUID.randomUUID().toString()
        return ScanProtocol.parseGroupProbe(request(nonce, ScanProtocol.groupProbeRequest(nonce), timeoutMs))
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
        return try { withTimeoutOrNull(timeoutMs) { deferred.await() } } finally { pending.remove(nonce) }
    }

    fun close() {
        abortDesktop()
        stopShareLinkContext()
        connectedUrl = null
        port?.let { runCatching { it.disconnect() } }
        port = null
        pending.values.forEach { it.complete(null) }
        pending.clear()
    }
}
