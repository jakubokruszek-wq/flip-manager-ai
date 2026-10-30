package pl.jakubokruszek.flipwatcher.geckopoc

import java.net.URI

/** One consent, one share link, navigation only. Never stores a post ID or a result URL. */
class ShareLinkResolver(
    private val group: String = PocPolicy.APPROVED_GROUP_ID,
    private val now: () -> Long,
    private val fixtureOrigin: String? = null,
    private val allowAddressReload: Boolean = false,
) {
    enum class Status { IDLE, ACTIVE, CONFIRMED, STOP, TIMEOUT }
    var status = Status.IDLE; private set
    var reason = "NOT_STARTED"; private set
    var requests = 0; private set
    var awaitingDocument = false; private set
    private var target: String? = null
    private var requested: String? = null
    private var location: String? = null
    private var previousDocument: String? = null
    private var deadline = 0L
    private var lastWait: ShareLinkWait? = null
    fun waitingFor(condition: ShareLinkWait) { if (active) lastWait = condition }
    val hasExactPostAddress: Boolean get() = location?.let(::uri)?.let(::exact) == true
    private var reloadTarget: String? = null
    private var reloadClaimed = false
    private var reloadUsed = false
    val pendingAddressReload: String? get() = if (active && !reloadClaimed) reloadTarget else null
    /** Only native UI orchestration can consume this once; never a persisted permission. */
    fun claimAddressReload(raw: String): Boolean {
        if (!tick() || reloadTarget != raw || reloadClaimed) return false
        reloadClaimed = true
        return true
    }
    val active: Boolean get() = status == Status.ACTIVE

    private fun uri(raw: String): URI? = runCatching { URI(raw) }.getOrNull()?.takeIf { u ->
        raw.length <= 2048 && u.rawUserInfo == null && u.rawFragment == null &&
            (if (fixtureOrigin != null) u.scheme == "http" && u.host == "127.0.0.1" && "${u.scheme}://${u.rawAuthority}" == fixtureOrigin
             else u.scheme == "https" && u.port == -1 && u.host in setOf("facebook.com", "www.facebook.com", "m.facebook.com"))
    }
    private fun share(u: URI) = Regex("^/share/p/[A-Za-z0-9]{6,40}/?$").matches(u.rawPath.orEmpty()) && u.rawQuery == null
    private fun exact(u: URI) = u.rawQuery == null && Regex("^/groups/" + Regex.escape(group) + "/(?:posts|permalink)/[0-9]{5,30}/?$").matches(u.rawPath.orEmpty())
    private fun destination(raw: String): Boolean {
        val u = uri(raw) ?: return false
        return exact(u) || (share(u) && u.rawPath?.trimEnd('/') == target?.let(::uri)?.rawPath?.trimEnd('/'))
    }
    fun begin(raw: String, consent: Boolean, sourceUrl: String? = null): Boolean {
        if (status != Status.IDLE) return false
        val u = uri(raw)
        if (!consent || u == null || !share(u)) { stop("INVALID_INPUT_OR_NO_CONSENT"); return false }
        // Only the exact approved group document present before navigation can be stale.
        // It is never a destination, never inspected, and cannot confirm a result.
        previousDocument = sourceUrl?.takeIf { value ->
            uri(value)?.rawPath?.trimEnd('/') == "/groups/$group"
        }
        target = raw; awaitingDocument = true; deadline = now() + 20_000; status = Status.ACTIVE; reason = "WAITING"; return true
    }
    fun tick(): Boolean {
        if (active && now() >= deadline) { status = Status.TIMEOUT; reason = lastWait?.code ?: "DEADLINE"; clear() }
        return active
    }
    fun request(raw: String, redirect: Boolean, newWindow: Boolean = false, gesture: Boolean = false): Boolean {
        if (!tick()) return false
        val first = requests == 0 && raw == target
        val recheck = reloadClaimed && raw == reloadTarget && !redirect && !gesture
        if (reloadTarget != null && !recheck) { stop("RELOAD_INTERRUPTED"); return false }
        if (newWindow || (!first && !recheck && (!redirect || gesture))) { stop("UNEXPECTED_NAVIGATION"); return false }
        val path = uri(raw)?.rawPath.orEmpty()
        if (Regex("login|recover|checkpoint|captcha|two_step_verification", RegexOption.IGNORE_CASE).containsMatchIn(path)) { stop("VERIFICATION_OR_LOGIN"); return false }
        if (!destination(raw)) { stop("UNVERIFIED_DESTINATION"); return false }
        if (requests >= 8) { stop("REDIRECT_LIMIT"); return false }
        requests++; requested = raw; awaitingDocument = true; location = null
        if (recheck) { reloadTarget = null; reloadClaimed = false }
        return true
    }
    fun location(raw: String?, gesture: Boolean = false): Boolean {
        if (!tick()) return false
        // Gecko can deliver an already queued location notification for the starting
        // document after loadUri/onLoadRequest. Ignore only that exact document until
        // the first target location; do not extend the deadline or arm its content port.
        if (previousDocument != null && raw == previousDocument && requests <= 1 && location == null) return true
        if (reloadTarget != null) {
            if (raw == reloadTarget && !gesture) return true // queued duplicate; still no inspection
            stop("RELOAD_INTERRUPTED"); return false
        }
        if (raw != null && raw != requested && requests > 0 && destination(raw) && allowAddressReload) {
            if (gesture) { stop("UNEXPECTED_NAVIGATION"); return false }
            if (reloadUsed) { stop("RELOAD_LIMIT"); return false }
            if (requests >= 8) { stop("REDIRECT_LIMIT"); return false }
            // History/canonicalization is a candidate address, never redirect proof.
            // Require one fresh native load and a new private content port before confirmation.
            reloadUsed = true; reloadTarget = raw; previousDocument = null
            location = null; awaitingDocument = true
            return true
        }
        val failure = when {
            raw == null -> "LOCATION_MISSING"
            requests == 0 -> "LOCATION_BEFORE_REQUEST"
            !destination(raw) -> "LOCATION_UNVERIFIED"
            raw != requested -> "LOCATION_WITHOUT_REQUEST"
            else -> null
        }
        if (failure != null) { stop(failure); return false }
        previousDocument = null
        location = raw; return true
    }
    fun canInspect(raw: String): Boolean = active && location == raw && requested == raw
    fun confirm(raw: String, safe: Boolean, complete: Boolean): Boolean {
        if (!tick() || location != raw) return false
        if (!safe) { stop("UNSAFE_DOCUMENT"); return false }
        awaitingDocument = false
        if (complete && uri(raw)?.let(::exact) == true) {
            status = Status.CONFIRMED; reason = if (reloadUsed) "EXACT_APPROVED_ADDRESS_RELOADED" else "EXACT_APPROVED_GROUP_LINK"; clear(); return true
        }
        return false
    }
    fun disconnected() { if (active && !awaitingDocument) stop("PORT_LOST") }
    fun stop(why: String = "CANCELLED") { if (status == Status.CONFIRMED) return; status = Status.STOP; reason = why; clear() }
    private fun clear() { target = null; requested = null; location = null; previousDocument = null; reloadTarget = null; reloadClaimed = false; lastWait = null; awaitingDocument = false }
    fun report() = "LINK 0.4.4 • tylko lokalnie • ${status.name}\n" +
        "Wynik: $reason\nŻądania nawigacji: $requests/8\nPotwierdzone ID z adresu zatwierdzonej grupy: ${if (status == Status.CONFIRMED) 1 else 0}\n" +
        "Potwierdzenie dotyczy adresu, nie treści ani kompletności oferty. Bez skanu, zapisu linku/ID i uploadu. Inna lub niezweryfikowana numeryczna grupa: STOP."
}
