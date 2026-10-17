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
import pl.jakubokruszek.flipcollector.collector.LivePilotSource
import java.io.ByteArrayInputStream

/**
 * Session browser. LivePilotChannel connects this same WebView to the pinned
 * extension core. Both production and pilot gates default to closed.
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
    private val pilotSource: LivePilotSource? = null,
    private val onViewCreated: (WebView) -> Unit = {},
) : CollectorBrowser {
    private var webView: WebView? = null
    private var finishedUrl: String? = null
    private val blockedResources = java.util.concurrent.atomic.AtomicInteger(0)
    private var mainFrameError: String? = null
    internal fun blockedResourceCount(): Int = blockedResources.get()
    internal fun documentReady() = pilotSource?.matchesPage(finishedUrl.orEmpty()) == true &&
        pilotSource.matchesPage(webView?.url.orEmpty()) && webView?.progress == 100
    internal var onPageReady: ((WebView, String) -> Unit)? = null
    internal var onStop: ((String) -> Unit)? = null
    /** Status codes only, never URLs, query strings, credentials, cookies or page text. */
    internal var onDiagnostic: ((String) -> Unit)? = null
    internal fun currentView(): WebView? = webView
    private var localFixture: String? = null
    internal fun isLocalFixture() = localFixture != null
    /** Debug instrumentation only: all resources are blocked, including the initial document. */
    internal fun useLocalFixture(html: String) {
        check(pl.jakubokruszek.flipcollector.BuildConfig.DEBUG && webView == null)
        require(html.length <= 2 * 1024 * 1024)
        localFixture = html
    }

    fun blockers(): List<BrowserBlocker> = buildList {
        if (!gate.open) add(BrowserBlocker.GATE_CLOSED)
        if (Looper.myLooper() != Looper.getMainLooper()) add(BrowserBlocker.NOT_MAIN_THREAD)
        if (context.getSystemService(PowerManager::class.java)?.isInteractive != true) add(BrowserBlocker.SCREEN_OFF)
    }

    override fun open(url: String) = openPage(url, navigate = true)
    internal fun prepare(url: String) = openPage(url, navigate = false)

    /** A separate, explicit operator action: load Facebook's login in the existing WebView.
     *  Never follow an external login provider or open a second window. */
    internal fun openLogin() {
        val source = requireNotNull(pilotSource) { "PILOT_SOURCE_REQUIRED" }
        check(webView != null) { "PILOT_SESSION_REQUIRED" }
        openPage(source.manualLoginUrl(), navigate = true, manualLogin = true)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun openPage(url: String, navigate: Boolean, manualLogin: Boolean = false) {
        gate.check()
        blockers().firstOrNull()?.let { throw IllegalStateException(it.message) }
        require(WebViewPolicy.navigation(url) == WebViewPolicy.Decision.ALLOW) { "Adres spoza Facebooka jest zablokowany" }
        require(pilotSource == null || pilotSource.matchesPage(url) || (manualLogin && url == pilotSource.manualLoginUrl())) { "PILOT_SOURCE_MISMATCH" }
        val view = webView ?: WebView(context).also { created ->
            created.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                // Use the platform WebView identity; no UA spoofing.
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
                if (localFixture != null) blockNetworkLoads = true
            }
            CookieManager.getInstance().apply {
                // First-party cookies hold the Facebook session; allowed only
                // because the gate (which includes the user's consent) is open.
                setAcceptCookie(true)
                setAcceptThirdPartyCookies(created, false)
            }
            created.webViewClient = PolicyWebViewClient()
            webView = created
            onViewCreated(created)
        }
        if (!navigate) return
        finishedUrl = null
        if (localFixture != null) {
            view.settings.javaScriptEnabled = false
            view.loadDataWithBaseURL(url, requireNotNull(localFixture), "text/html", "UTF-8", url)
        } else view.loadUrl(url)
    }

    override fun close() {
        webView?.apply {
            stopLoading()
            loadUrl("about:blank")
            removeAllViews()
            destroy()
        }
        webView = null
        finishedUrl = null
    }

    private inner class PolicyWebViewClient : WebViewClient() {
        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            finishedUrl = null
            mainFrameError = null
            blockedResources.set(0)
            val kind = when {
                pilotSource?.matchesPage(url) == true -> "GROUP"
                runCatching { java.net.URI(url).path.orEmpty().startsWith("/login") }.getOrDefault(false) -> "LOGIN"
                else -> "OTHER"
            }
            onDiagnostic?.invoke("PAGE_STARTED_$kind")
        }
        override fun onReceivedSslError(view: WebView, handler: android.webkit.SslErrorHandler, error: android.net.http.SslError) {
            handler.cancel()
            mainFrameError = "TLS_ERROR"
            onDiagnostic?.invoke("TLS_ERROR")
            onStop?.invoke("TLS_ERROR")
        }
        override fun onPageFinished(view: WebView, url: String) {
            finishedUrl = url
            val kind = when {
                pilotSource?.matchesPage(url) == true -> "GROUP"
                runCatching { java.net.URI(url).path.orEmpty().startsWith("/login") }.getOrDefault(false) -> "LOGIN"
                else -> "OTHER"
            }
            onDiagnostic?.invoke(mainFrameError ?: ("PAGE_FINISHED_$kind" + "_PROGRESS_" + view.progress))
            onPageReady?.invoke(view, url)
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.isForMainFrame) {
                mainFrameError = "MAIN_FRAME_HTTP_" + response.statusCode
                onDiagnostic?.invoke(requireNotNull(mainFrameError))
                onStop?.invoke(if (response.statusCode == 403) "HTTP_403" else "HTTP_ERROR")
            }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
            if (request.isForMainFrame) {
                mainFrameError = "MAIN_FRAME_NETWORK_" + error.errorCode
                onDiagnostic?.invoke(requireNotNull(mainFrameError))
                onStop?.invoke("WEBVIEW_NETWORK_ERROR")
            }
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (WebViewPolicy.navigation(url) == WebViewPolicy.Decision.ALLOW) {
                if (!request.isForMainFrame || pilotSource == null || pilotSource.matchesPage(url)) return false
                // Session UI may show Facebook's own login/challenge pages, but
                // collecting stops immediately; never follow another group/post.
                val path = request.url.path.orEmpty()
                val code = when {
                    path.contains("checkpoint") -> "CHECKPOINT"
                    path.contains("captcha") -> "CAPTCHA"
                    path.contains("login") || path.contains("recover") -> "LOGIN_REQUIRED"
                    else -> "PILOT_REDIRECT_BLOCKED"
                }
                onDiagnostic?.invoke("NAVIGATION_$code")
                onStop?.invoke(code)
                return code == "PILOT_REDIRECT_BLOCKED"
            }
            onDiagnostic?.invoke("NAVIGATION_BLOCKED")
            onStop?.invoke("PILOT_REDIRECT_BLOCKED")
            onBlockedNavigation(url.take(200))
            return true
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            if (localFixture != null) return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
            val allowed = if (pilotSource != null) {
                pl.jakubokruszek.flipcollector.collector.LivePilotPolicy.allowResource(request.url.toString())
            } else WebViewPolicy.resource(request.url.toString()) == WebViewPolicy.Decision.ALLOW
            if (allowed) return null
            // A counter only: no login URL, path, query, headers or request body is recorded.
            blockedResources.incrementAndGet()
            return WebResourceResponse("text/plain", "utf-8", 204, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }

        /** The renderer died (OOM kill while backgrounded, or crash): drop this WebView, never touch it again. */
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view === webView) {
                webView = null
                view.destroy()
            }
            onDiagnostic?.invoke("RENDERER_GONE")
            onRendererGone(detail.didCrash())
            onStop?.invoke("RENDERER_GONE")
            return true
        }
    }

    companion object {
        /** "Usuń sesję Facebooka": cookies and web storage of every WebView in the app. */
        fun clearSession(onDone: () -> Unit = {}) {
            WebStorage.getInstance().deleteAllData()
            CookieManager.getInstance().removeAllCookies { CookieManager.getInstance().flush(); onDone() }
        }
    }
}

