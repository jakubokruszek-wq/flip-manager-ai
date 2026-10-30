package pl.jakubokruszek.flipwatcher.geckopoc

import java.net.URI
import java.net.URLEncoder

/** Group id used by every local fixture page. */
const val FIXTURE_GROUP_ID = "1234567890123"

/** What the session is showing, from the top-level URL alone. */
enum class PageKind { APPROVED_GROUP, APPROVED_POST, OTHER_GROUP, LOGIN, CHECKPOINT, CAPTCHA, FACEBOOK_OTHER, FIXTURE, BLOCKED, BLANK }

/**
 * Fixed rules of the POC: one selected Watcher group, Facebook hosts only, and a stop
 * on every verification page. Pure Kotlin, so the JVM tests cover all of it.
 */
object PocPolicy {
    /** Selected exact Watcher source; switching requires closing all browser operations. */
    @Volatile private var selectedGroupId = WatcherGroups.LEGACY_GROUP
    val APPROVED_GROUP_ID: String get() = selectedGroupId
    /** Caller must close all document operations and invalidate callbacks before switching. */
    fun selectGroup(id:String) { require(WatcherGroups.find(id)!=null);selectedGroupId=id }
    val APPROVED_GROUP_URL: String get() = "https://www.facebook.com/groups/$APPROVED_GROUP_ID/"
    const val MAX_POSTS = 20
    const val SCAN_TIMEOUT_MS = 45_000L
    const val NATIVE_APP = "flipPoc"
    const val EXTENSION_ID = "flip-gecko-poc@flip-manager.local"
    const val EXTENSION_LOCATION = "resource://android/assets/ext/flip_poc/"

    /**
     * Additional verified aliases: slug -> independently approved source key.
     * Intentionally EMPTY. The standalone source "lodzsprzedazzakupwynajem"
     * is approved by its exact URL, NOT as an alias of numeric group 402796264871862.
     * Never infer equality of source identities from similar names or redirects.
     */
    val VERIFIED_ALIASES: Map<String, String> = emptyMap()

    /** Other slugs independently verified to resolve to [groupId]; none in the current POC. */
    fun aliasesFor(groupId: String, aliases: Map<String, String> = VERIFIED_ALIASES): List<String> =
        aliases.filterValues { it == groupId }.keys.sorted()

    /** The official login page; after login Facebook returns to the approved group. */
    val LOGIN_URL: String get() = "https://www.facebook.com/login/?next=" + URLEncoder.encode(APPROVED_GROUP_URL, "UTF-8")

    private val FACEBOOK_HOSTS = setOf("facebook.com", "www.facebook.com", "m.facebook.com")

    fun isFacebookHost(host: String?): Boolean {
        val value = host?.lowercase() ?: return false
        return value in FACEBOOK_HOSTS || value.endsWith(".facebook.com")
    }

    /** The group segment of a /groups/<id-or-slug>/ path, or null. */
    fun groupSegment(url: String?): String? {
        val path = runCatching { URI(url ?: return null).rawPath }.getOrNull() ?: return null
        return Regex("^/groups/([^/]+)/?$").find(path)?.groupValues?.get(1)
    }

    fun classify(url: String?, fixtureMode: Boolean = false, aliases: Map<String, String> = VERIFIED_ALIASES): PageKind {
        if (url.isNullOrBlank() || url == "about:blank") return PageKind.BLANK
        val uri = runCatching { URI(url) }.getOrNull() ?: return PageKind.BLOCKED
        val host = uri.host?.lowercase()
        if (fixtureMode && uri.scheme == "http" && host == "127.0.0.1") return PageKind.FIXTURE
        if (uri.scheme != "https" || !isFacebookHost(host)) return PageKind.BLOCKED
        val path = uri.rawPath.orEmpty()
        return when {
            Regex("checkpoint|two_step_verification", RegexOption.IGNORE_CASE).containsMatchIn(path) -> PageKind.CHECKPOINT
            Regex("captcha", RegexOption.IGNORE_CASE).containsMatchIn(path) -> PageKind.CAPTCHA
            Regex("^/(login|recover)", RegexOption.IGNORE_CASE).containsMatchIn(path) -> PageKind.LOGIN
            path.trimEnd('/') == "/groups/$APPROVED_GROUP_ID" -> PageKind.APPROVED_GROUP
            // Only an exact, verified alias of the approved group; never any /groups/ path.
            groupSegment(url)?.let { aliases[it] == APPROVED_GROUP_ID } == true -> PageKind.APPROVED_GROUP
            // Viewing an exact post is distinct from permission to scan a group.
            uri.rawUserInfo==null&&uri.port==-1&&uri.rawQuery==null&&uri.rawFragment==null&&
                Regex("^/groups/${Regex.escape(APPROVED_GROUP_ID)}/(posts|permalink)/[0-9]{5,30}/?$").matches(path) -> PageKind.APPROVED_POST
            path.startsWith("/groups/") -> PageKind.OTHER_GROUP
            else -> PageKind.FACEBOOK_OTHER
        }
    }

    /**
     * Top-level navigation guard. Facebook (including its login and
     * verification pages, which the operator completes by hand) is allowed;
     * anything else is blocked and shown in diagnostics. Subresources are not
     * filtered: the page loads exactly as in a normal browser.
     */
    fun allowNavigation(url: String?, fixtureMode: Boolean = false): Boolean = when (classify(url, fixtureMode)) {
        PageKind.BLOCKED -> url?.startsWith("about:") == true
        else -> true
    }

    /** Only these pages may be scanned; everything else is a STOP for automation. */
    fun canScan(kind: PageKind): Boolean = kind == PageKind.APPROVED_GROUP || kind == PageKind.FIXTURE

    /** A message port is trusted only from the top frame of Facebook (or the local fixture server in fixture mode). */
    fun isTrustedSender(url: String?, isTopLevel: Boolean, fixtureMode: Boolean): Boolean {
        if (!isTopLevel) return false
        val kind = classify(url, fixtureMode)
        return kind != PageKind.BLOCKED && kind != PageKind.BLANK
    }

    /** Scheme, host and path only: query strings and fragments can carry tokens and never reach the screen or logs. */
    fun sanitize(url: String?): String {
        if (url.isNullOrBlank()) return "—"
        val uri = runCatching { URI(url) }.getOrNull() ?: return "(nieprawidłowy adres)"
        if (uri.scheme == null || uri.host == null) return uri.scheme?.let { "$it:" } ?: "(nieprawidłowy adres)"
        val port = if (uri.port > 0) ":${uri.port}" else ""
        return "${uri.scheme}://${uri.host}$port${uri.rawPath.orEmpty().take(120)}"
    }

    fun stopMessage(kind: PageKind, loginRequested: Boolean): String? = when (kind) {
        PageKind.CHECKPOINT -> "STOP: Facebook prosi o weryfikację (checkpoint). Automat wstrzymany. Możesz dokończyć ją ręcznie albo zamknąć sesję."
        PageKind.CAPTCHA -> "STOP: Facebook wyświetla CAPTCHA. Automat wstrzymany; nic nie jest rozwiązywane automatycznie."
        PageKind.LOGIN -> if (loginRequested) null else "STOP: wymagane logowanie. Użyj „Zaloguj się”."
        PageKind.OTHER_GROUP -> "STOP: ten adres grupy nie jest zatwierdzony (inna grupa albo niezweryfikowany alias). Użyj „Diagnoza grupy” albo „Wróć do grupy”."
        PageKind.BLOCKED -> "STOP: adres spoza Facebooka został zablokowany."
        else -> null
    }
}
