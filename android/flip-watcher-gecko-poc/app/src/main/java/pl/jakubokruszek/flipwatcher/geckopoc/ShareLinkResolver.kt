package pl.jakubokruszek.flipwatcher.geckopoc

import java.net.URI

/** One consent, one share link, navigation only. Never stores a post ID or a result URL. */
class ShareLinkResolver(
    private val group: String = PocPolicy.APPROVED_GROUP_ID,
    private val now: () -> Long,
    private val fixtureOrigin: String? = null,
) {
    enum class Status { IDLE, ACTIVE, CONFIRMED, STOP, TIMEOUT }
    var status = Status.IDLE; private set
    var reason = "NOT_STARTED"; private set
    var requests = 0; private set
    var awaitingDocument = false; private set
    private var target: String? = null
    private var requested: String? = null
    private var location: String? = null
    private var deadline = 0L
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
    fun begin(raw: String, consent: Boolean): Boolean {
        if (status != Status.IDLE) return false
        val u = uri(raw)
        if (!consent || u == null || !share(u)) { stop("INVALID_INPUT_OR_NO_CONSENT"); return false }
        target = raw; awaitingDocument = true; deadline = now() + 20_000; status = Status.ACTIVE; reason = "WAITING"; return true
    }
    fun tick(): Boolean {
        if (active && now() >= deadline) { status = Status.TIMEOUT; reason = "DEADLINE"; clear() }
        return active
    }
    fun request(raw: String, redirect: Boolean, newWindow: Boolean = false, gesture: Boolean = false): Boolean {
        if (!tick()) return false
        val first = requests == 0 && raw == target
        if (newWindow || (!first && (!redirect || gesture))) { stop("UNEXPECTED_NAVIGATION"); return false }
        val path = uri(raw)?.rawPath.orEmpty()
        if (Regex("login|recover|checkpoint|captcha|two_step_verification", RegexOption.IGNORE_CASE).containsMatchIn(path)) { stop("VERIFICATION_OR_LOGIN"); return false }
        if (!destination(raw)) { stop("UNVERIFIED_DESTINATION"); return false }
        if (requests >= 8) { stop("REDIRECT_LIMIT"); return false }
        requests++; requested = raw; awaitingDocument = true; location = null; return true
    }
    fun location(raw: String?): Boolean {
        if (!tick()) return false
        if (raw == null || raw != requested || requests == 0 || !destination(raw)) { stop("CONTEXT_CHANGED"); return false }
        location = raw; return true
    }
    fun confirm(raw: String, safe: Boolean, complete: Boolean): Boolean {
        if (!tick() || location != raw) return false
        if (!safe) { stop("UNSAFE_DOCUMENT"); return false }
        awaitingDocument = false
        if (complete && uri(raw)?.let(::exact) == true) {
            status = Status.CONFIRMED; reason = "EXACT_APPROVED_GROUP_LINK"; clear(); return true
        }
        return false
    }
    fun disconnected() { if (active && !awaitingDocument) stop("PORT_LOST") }
    fun stop(why: String = "CANCELLED") { if (status == Status.CONFIRMED) return; status = Status.STOP; reason = why; clear() }
    private fun clear() { target = null; requested = null; location = null; awaitingDocument = false }
    fun report() = "LINK 0.4.1 • tylko lokalnie • ${status.name}\n" +
        "Wynik: $reason\nŻądania nawigacji: $requests/8\nPotwierdzone ID z adresu zatwierdzonej grupy: ${if (status == Status.CONFIRMED) 1 else 0}\n" +
        "Potwierdzenie dotyczy adresu, nie treści ani kompletności oferty. Bez skanu, zapisu linku/ID i uploadu. Inna lub niezweryfikowana numeryczna grupa: STOP."
}
