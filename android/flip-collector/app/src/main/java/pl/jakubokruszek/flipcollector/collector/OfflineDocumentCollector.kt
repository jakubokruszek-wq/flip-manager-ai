package pl.jakubokruszek.flipcollector.collector

import android.annotation.SuppressLint
import android.content.Context
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Local HTML only. No navigation API, no file access, cookies or JS bridge. */
class OfflineDocumentCollector(private val context: Context) {
    @SuppressLint("SetJavaScriptEnabled")
    suspend fun collect(html: String, source: JSONObject): JSONObject = lock.withLock {
        require(html.toByteArray(Charsets.UTF_8).size <= 2 * 1024 * 1024)
        withContext(Dispatchers.Main) {
            val view = WebView(context.applicationContext)
            try {
                CookieManager.getInstance().setAcceptCookie(false)
                CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
                view.settings.apply {
                    javaScriptEnabled = false // Fixture scripts must never execute.
                    domStorageEnabled = false
                    allowFileAccess = false
                    allowContentAccess = false
                    blockNetworkLoads = true
                    blockNetworkImage = true
                    loadsImagesAutomatically = false
                    javaScriptCanOpenWindowsAutomatically = false
                    setSupportMultipleWindows(false)
                }
                val core = context.assets.open("collector-core.js").bufferedReader().use { it.readText() }
                val adapter = context.assets.open("facebook-offline-adapter.js").bufferedReader().use { it.readText() }
                withTimeout(15_000) {
                    suspendCancellableCoroutine { continuation ->
                        view.webViewClient = object : WebViewClient() {
                            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
                            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
                                WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
                            override fun onPageFinished(view: WebView, url: String) {
                                if (!continuation.isActive) return
                                view.settings.javaScriptEnabled = true
                                val script = "$core\n$adapter\nJSON.stringify(FlipAndroidOfflineAdapter.collect(document, $source));"
                                view.evaluateJavascript(script) { result ->
                                    if (!continuation.isActive) return@evaluateJavascript
                                    try { continuation.resume(JSONObject(JSONArray("[$result]").getString(0))) }
                                    catch (_: Exception) { continuation.resumeWithException(IllegalStateException("OFFLINE_EXTRACTION_FAILED")) }
                                }
                            }
                        }
                        view.loadDataWithBaseURL("https://offline.flip.invalid/", html, "text/html", "UTF-8", null)
                    }
                }
            } finally { view.stopLoading(); view.removeAllViews(); view.destroy() }
        }
    }
    companion object { private val lock = Mutex() }
}
