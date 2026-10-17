package pl.jakubokruszek.flipcollector.collector

import java.net.URI

/**
 * Security rules of the future collector WebView, kept free of Android so
 * they are unit-tested (WebViewPolicyTest). CollectorBrowser applies them.
 *
 * - Navigation: only HTTPS pages on www.facebook.com / m.facebook.com /
 *   facebook.com. Everything else (other sites, l.facebook.com redirect
 *   links, intent:, file:, javascript:, data:, http:) is refused, so a post
 *   link can never take the scanner off Facebook.
 * - Sub-resources: Facebook pages plus its static and media CDNs; images and
 *   video are blocked (data-only scans, as in the extension).
 */
object WebViewPolicy {
    private val PAGE_HOSTS = setOf("www.facebook.com", "m.facebook.com", "facebook.com")
    private val RESOURCE_SUFFIXES = listOf(".facebook.com", ".fbcdn.net", ".facebook.net")
    private val MEDIA_EXTENSIONS = Regex("\\.(jpe?g|png|gif|webp|avif|heic|mp4|webm|m4v)(\\?|$)", RegexOption.IGNORE_CASE)

    enum class Decision { ALLOW, BLOCK }

    /** May the top-level frame navigate to [url]? */
    fun navigation(url: String): Decision {
        val uri = parse(url) ?: return Decision.BLOCK
        if (uri.scheme?.lowercase() != "https") return Decision.BLOCK
        if (uri.userInfo != null) return Decision.BLOCK
        if (uri.port != -1 && uri.port != 443) return Decision.BLOCK
        val host = uri.host?.lowercase() ?: return Decision.BLOCK
        return if (host in PAGE_HOSTS) Decision.ALLOW else Decision.BLOCK
    }

    /** May the page load sub-resource [url] (script, XHR, image)? */
    fun resource(url: String, blockMedia: Boolean = true): Decision {
        val uri = parse(url) ?: return Decision.BLOCK
        if (uri.scheme?.lowercase() != "https") return Decision.BLOCK
        val host = uri.host?.lowercase() ?: return Decision.BLOCK
        val known = host in PAGE_HOSTS || RESOURCE_SUFFIXES.any { host.endsWith(it) }
        if (!known) return Decision.BLOCK
        if (blockMedia && MEDIA_EXTENSIONS.containsMatchIn(uri.rawPath.orEmpty() + (uri.rawQuery?.let { "?$it" } ?: ""))) return Decision.BLOCK
        return Decision.ALLOW
    }

    private fun parse(url: String): URI? = runCatching { URI(url.trim()) }.getOrNull()?.takeIf { it.isAbsolute }
}
