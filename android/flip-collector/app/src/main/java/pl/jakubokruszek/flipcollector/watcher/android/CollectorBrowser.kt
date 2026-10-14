package pl.jakubokruszek.flipcollector.watcher.android

import android.annotation.SuppressLint
import android.content.Context
import android.webkit.CookieManager
import android.webkit.WebView
import pl.jakubokruszek.flipcollector.collector.LiveCollectionGate

/**
 * Seam for the future live collector. The plan (not active in this release):
 * one off-screen WebView with a desktop User-Agent opens a watched group on
 * www.facebook.com, the existing extension scripts (collector-core.js,
 * network-hook.js, content.js) are injected with a small chrome.* shim, and
 * results go to /api/collector/facebook/batches under the claimed job's
 * lease. Image blocking replaces declarativeNetRequest via
 * shouldInterceptRequest.
 *
 * Nothing here runs while [LiveCollectionGate] is closed, and it is closed in
 * this build (BuildConfig.LIVE_COLLECTION_ENABLED = false), so the app never
 * loads Facebook and never stores a Facebook session.
 */
interface CollectorBrowser {
    fun open(url: String)
    fun close()
}

class WebViewCollectorBrowser(
    private val context: Context,
    private val gate: LiveCollectionGate,
) : CollectorBrowser {
    private var webView: WebView? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun open(url: String) {
        gate.check()
        require(url.startsWith("https://www.facebook.com/")) { "Only www.facebook.com sources are allowed" }
        val view = webView ?: WebView(context.applicationContext).also { created ->
            created.settings.javaScriptEnabled = true
            created.settings.userAgentString = DESKTOP_USER_AGENT
            created.settings.loadsImagesAutomatically = false
            // Cookies (the Facebook session) are kept only after the user's
            // separate consent, which the gate already required above.
            CookieManager.getInstance().setAcceptCookie(true)
            webView = created
        }
        view.loadUrl(url)
    }

    override fun close() {
        webView?.apply {
            stopLoading()
            destroy()
        }
        webView = null
    }

    private companion object {
        const val DESKTOP_USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    }
}
