package pl.jakubokruszek.flipcollector.watcher.android

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.os.Looper
import android.os.PowerManager
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import pl.jakubokruszek.flipcollector.collector.LiveCollectionGate
import pl.jakubokruszek.flipcollector.collector.WebViewPolicy
import java.io.ByteArrayInputStream

/**
 * Seam for the future live collector (not active: [LiveCollectionGate] is
 * closed in this build). Security review and lifecycle: docs/webview-bezpieczenstwo.md.
 *
 * Plan: one off-screen WebView with a desktop User-Agent opens a watched
 * group on www.facebook.com; the extension's collector scripts are injected
 * through a WebMessage channel (never addJavascriptInterface); results go to
 * the backend under the claimed job's lease.
 */
interface CollectorBrowser {
    fun open(url: String)
    fun close()
}

/** Why a live session cannot start now; checked before any WebView exists. */
enum class BrowserBlocker(val message: String) {
    GATE_CLOSED("Zbieranie na żywo jest wyłączone."),
    NOT_MAIN_THREAD("WebView wymaga wątku głównego."),
    SCREEN_OFF("Ekran jest wygaszony — WebView może zostać wstrzymany; skan na żywo wymaga włączonego ekranu do czasu testów fizycznych."),
}

class WebViewCollectorBrowser(
    private val context: Context,
    private val gate: LiveCollectionGate,
    private val onRendererGone: (crashed: Boolean) -> Unit = {},
    private val onBlockedNavigation: (String) -> Unit = {},
) : CollectorBrowser {
    private var webView: WebView? = null

    fun blockers(): List<BrowserBlocker> = buildList {
        if (!gate.open) add(BrowserBlocker.GATE_CLOSED)
        if (Looper.myLooper() != Looper.getMainLooper()) add(BrowserBlocker.NOT_MAIN_THREAD)
        if (context.getSystemService(PowerManager::class.java)?.isInteractive != true) add(BrowserBlocker.SCREEN_OFF)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun open(url: String) {
        gate.check()
        blockers().firstOrNull()?.let { throw IllegalStateException(it.message) }
        require(WebViewPolicy.navigation(url) == WebViewPolicy.Decision.ALLOW) { "Adres spoza Facebooka jest zablokowany" }
        val view = webView ?: WebView(context.applicationContext).also { created ->
            created.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                userAgentString = DESKTOP_USER_AGENT
                loadsImagesAutomatically = false
                blockNetworkImage = true
                allowFileAccess = false
                allowContentAccess = false
                javaScriptCanOpenWindowsAutomatically = false
                setSupportMultipleWindows(false)
                setGeolocationEnabled(false)
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                mediaPlaybackRequiresUserGesture = true
                cacheMode = WebSettings.LOAD_DEFAULT
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) safeBrowsingEnabled = true
            }
            CookieManager.getInstance().apply {
                // First-party cookies hold the Facebook session; allowed only
                // because the gate (which includes the user's consent) is open.
                setAcceptCookie(true)
                setAcceptThirdPartyCookies(created, false)
            }
            created.webViewClient = PolicyWebViewClient()
            webView = created
        }
        view.loadUrl(url)
    }

    override fun close() {
        webView?.apply {
            stopLoading()
            loadUrl("about:blank")
            removeAllViews()
            destroy()
        }
        webView = null
    }

    private inner class PolicyWebViewClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (WebViewPolicy.navigation(url) == WebViewPolicy.Decision.ALLOW) return false
            onBlockedNavigation(url.take(200))
            return true
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            if (WebViewPolicy.resource(request.url.toString()) == WebViewPolicy.Decision.ALLOW) return null
            return WebResourceResponse("text/plain", "utf-8", 204, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }

        /** The renderer died (OOM kill while backgrounded, or crash): drop this WebView, never touch it again. */
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view === webView) {
                webView = null
                view.destroy()
            }
            onRendererGone(detail.didCrash())
            return true
        }
    }

    companion object {
        private const val DESKTOP_USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

        /** "Usuń sesję Facebooka": cookies and web storage of every WebView in the app. */
        fun clearSession(onDone: () -> Unit = {}) {
            WebStorage.getInstance().deleteAllData()
            CookieManager.getInstance().removeAllCookies { CookieManager.getInstance().flush(); onDone() }
        }
    }
}
