package pl.jakubokruszek.flipcollector.watcher.android

import android.content.Context
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.*
import org.json.JSONObject
import pl.jakubokruszek.flipcollector.collector.*
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Exact origin + main frame + current source + per-scan nonce. No JS interface. */
class LivePilotChannel(private val context: Context, private val browser: WebViewCollectorBrowser) {
    suspend fun collect(source: LivePilotSource): JSONObject = withContext(Dispatchers.Main) {
        check(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) { "WEB_MESSAGE_UNSUPPORTED" }
        check(browser.blockers().isEmpty()) { "PILOT_BROWSER_BLOCKED" }
        val view = requireNotNull(browser.currentView()) { "PILOT_SESSION_REQUIRED" }
        val core = context.assets.open("collector-core.js").bufferedReader().use { it.readText() }
        check(CollectorSigner.sha256Hex(core.toByteArray()) == LivePilotPolicy.CORE_SHA256) { "COLLECTOR_CORE_VERSION_MISMATCH" }
        val adapter = context.assets.open("facebook-offline-adapter.js").bufferedReader().use { it.readText() }
        val pilot = context.assets.open("facebook-live-pilot.js").bufferedReader().use { it.readText() }
        val nonce = UUID.randomUUID().toString()
        val startedAt = System.currentTimeMillis()
        try {
            withTimeout(LivePilotPolicy.TIMEOUT_MS) {
                coroutineScope {
                    val screenGuard = launch {
                        while (isActive) {
                            if (browser.blockers().isNotEmpty()) browser.onStop?.invoke("SCREEN_OFF")
                            delay(250)
                        }
                    }
                    try {
                        suspendCancellableCoroutine<JSONObject> { continuation ->
                            fun stop(code: String) {
                                if (continuation.isActive) continuation.resumeWithException(IllegalStateException(code))
                            }
                            browser.onStop = ::stop
                            WebViewCompat.addWebMessageListener(view, "FlipPilot", setOf(source.origin)) { _, message, origin, mainFrame, _ ->
                                if (!continuation.isActive) return@addWebMessageListener
                                if (!LivePilotPolicy.trustedMessage(origin.toString(), mainFrame, view.url.orEmpty(), source)) {
                                    stop("PILOT_ORIGIN_FRAME_REJECTED"); return@addWebMessageListener
                                }
                                try { continuation.resume(LivePilotPolicy.validate(requireNotNull(message.data), nonce, source)) }
                                catch (error: Exception) { continuation.resumeWithException(error) }
                            }
                            browser.onPageReady = { loaded, url ->
                                if (continuation.isActive) {
                                    if (!source.matchesPage(url)) stop("LOGIN_OR_GROUP_UNAVAILABLE")
                                    else {
                                        loaded.settings.javaScriptEnabled = true
                                        loaded.evaluateJavascript("$core\n$adapter\n$pilot\nFlipAndroidLivePilot(document, ${source.input()}, ${JSONObject.quote(nonce)}, $startedAt);", null)
                                    }
                                }
                            }
                            // Reload the approved group after installing the channel. No scroll or
                            // timer injection into an old document; redirects cannot reuse a result.
                            browser.open(source.url)
                        }
                    } finally { screenGuard.cancelAndJoin() }
                }
            }
        } finally {
            browser.onPageReady = null
            browser.onStop = null
            WebViewCompat.removeWebMessageListener(view, "FlipPilot")
            view.stopLoading()
        }
    }
}
