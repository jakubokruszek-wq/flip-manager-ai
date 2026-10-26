package pl.jakubokruszek.flipwatcher.geckopoc

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.WebExtension
import java.util.UUID

/**
 * Port between the app and the extension's BACKGROUND script (extension-level
 * native messaging, independent of any page). Used to arm the page-load
 * measurement before loadUri, read it and abort it. Main thread only.
 */
class BackgroundChannel {
    private var port: WebExtension.Port? = null
    private var portReady = CompletableDeferred<Unit>()
    private val pending = HashMap<String, CompletableDeferred<JSONObject?>>()

    val isConnected: Boolean get() = port != null

    private val portDelegate = object : WebExtension.PortDelegate {
        override fun onPortMessage(message: Any, port: WebExtension.Port) {
            if (port !== this@BackgroundChannel.port) return
            val json = ScanProtocol.asJson(message) ?: return
            pending.remove(json.optString("nonce"))?.complete(json)
        }

        override fun onDisconnect(port: WebExtension.Port) {
            if (port !== this@BackgroundChannel.port) return
            this@BackgroundChannel.port = null
            portReady = CompletableDeferred()
            pending.values.forEach { it.complete(null) }
            pending.clear()
        }
    }

    private val messageDelegate = object : WebExtension.MessageDelegate {
        override fun onConnect(port: WebExtension.Port) {
            // Only the extension's background (no session) may open this port.
            if (port.sender.session != null) { port.disconnect(); return }
            this@BackgroundChannel.port?.let { old -> runCatching { old.disconnect() } }
            this@BackgroundChannel.port = port
            port.setDelegate(portDelegate)
            portReady.complete(Unit)
        }

        override fun onMessage(nativeApp: String, message: Any, sender: WebExtension.MessageSender): GeckoResult<Any>? = null
    }

    fun abortResponseLoad(nonce: String) {
        runCatching { port?.postMessage(JSONObject().put("type", "abortResponseLoad").put("nonce", nonce)) }
    }

    fun abortDesktop(nonce:String){runCatching{port?.postMessage(JSONObject().put("type","abortDesktop").put("nonce",nonce))}}

    fun abortResponses() {
        runCatching { port?.postMessage(JSONObject().put("type", "abortResponse").put("nonce", UUID.randomUUID().toString())) }
    }

    fun attach(extension: WebExtension) {
        extension.setMessageDelegate(messageDelegate, PocPolicy.NATIVE_APP)
    }

    suspend fun awaitPort(timeoutMs: Long): Boolean = withTimeoutOrNull(timeoutMs) { portReady.await(); true } ?: false

    suspend fun ocrFields(id:String,texts:List<String>,consent:Boolean=false):DesktopRow?{
        if(!consent||!Regex("[0-9]{5,30}").matches(id)||texts.isEmpty()||texts.size>3||texts.any{it.length>12000}||texts.sumOf{it.length}>24000)return null
        val nonce=UUID.randomUUID().toString()
        val message=JSONObject().put("type","ocrFields").put("nonce",nonce).put("consent",true).put("groupId",PocPolicy.APPROVED_GROUP_ID).put("postId",id).put("texts",org.json.JSONArray(texts))
        return OcrProtocol.parse(request(message),nonce,id)
    }

    suspend fun request(message: JSONObject, timeoutMs: Long = 5_000): JSONObject? {
        val current = port ?: return null
        val nonce = message.optString("nonce").ifBlank { UUID.randomUUID().toString().also { message.put("nonce", it) } }
        val deferred = CompletableDeferred<JSONObject?>()
        pending[nonce] = deferred
        if (runCatching { current.postMessage(message) }.isFailure) {
            pending.remove(nonce)
            return null
        }
        return withTimeoutOrNull(timeoutMs) { deferred.await() }.also { pending.remove(nonce) }
    }
}
