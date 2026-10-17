package pl.jakubokruszek.flipwatcher.geckopoc

/**
 * One top-level navigation as GeckoView reported it (URL already sanitized):
 * a load request ([isRedirect] for an HTTP redirect) or, with [viaHistory], an
 * in-page address change (history API) reported by onLocationChange.
 */
data class NavStep(val url: String, val isRedirect: Boolean, val hasUserGesture: Boolean, val viaHistory: Boolean = false)

/** A numeric group id found on the page, and where: Facebook's app-link metadata ("strong") or page JSON ("weak"). */
data class GroupIdHit(val id: String, val source: String) {
    val strong: Boolean get() = source in STRONG_SOURCES

    companion object {
        val STRONG_SOURCES = setOf("al:android:url", "al:ios:url", "android-app", "ios-app")
    }
}

enum class GroupVerdict {
    /** The address is the approved numeric id itself. */
    APPROVED_NUMERIC,
    /** Facebook's own metadata names only the approved id AND Facebook (not a click) redirected the approved URL to this slug. */
    SAME_GROUP_EVIDENCE,
    /** Facebook's own metadata names a different group id. */
    DIFFERENT_GROUP,
    /** Not enough to decide either way. */
    INSUFFICIENT,
}

data class GroupAssessment(val verdict: GroupVerdict, val segment: String?, val strongIds: List<String>, val serverRedirect: Boolean, val reasons: List<String>)

/**
 * Decides, from evidence Facebook itself produced on the phone, whether the
 * group address shown is the approved group. It only REPORTS: a slug is
 * accepted for scanning solely through PocPolicy.VERIFIED_ALIASES, which is
 * changed by hand after the operator confirms this evidence. Names, titles
 * and pictures are never evidence.
 */
object GroupIdentity {
    fun assess(approvedId: String, segment: String?, hits: List<GroupIdHit>, trace: List<NavStep>): GroupAssessment {
        val strongIds = hits.filter { it.strong }.map { it.id }.distinct().sorted()
        val redirect = segment != null && serverRedirected(approvedId, segment, trace)
        val reasons = mutableListOf<String>()
        reasons += "adres: /groups/${segment ?: "?"}/"
        reasons += if (strongIds.isEmpty()) "metadane Facebooka: brak numerycznego ID grupy" else "metadane Facebooka: ${strongIds.joinToString()}"
        reasons += if (redirect) "Facebook sam zmienił adres /groups/$approvedId/ na ten (przekierowanie bez kliknięcia)" else "brak serwerowego przekierowania z /groups/$approvedId/ na ten adres"
        val verdict = when {
            segment == approvedId -> GroupVerdict.APPROVED_NUMERIC
            strongIds.isNotEmpty() && approvedId !in strongIds -> GroupVerdict.DIFFERENT_GROUP
            strongIds == listOf(approvedId) && redirect -> GroupVerdict.SAME_GROUP_EVIDENCE
            else -> GroupVerdict.INSUFFICIENT
        }
        return GroupAssessment(verdict, segment, strongIds, redirect, reasons)
    }

    /**
     * True when a load of /groups/[approvedId]/ was followed, without any user
     * gesture, by Facebook moving to /groups/[segment]/ (HTTP redirect or
     * in-page address change). Any click, or a fresh load elsewhere, breaks the chain.
     */
    fun serverRedirected(approvedId: String, segment: String, trace: List<NavStep>): Boolean {
        val start = trace.indexOfLast { PocPolicy.groupSegment(it.url) == approvedId && !it.hasUserGesture }
        if (start < 0) return false
        for (step in trace.drop(start + 1)) {
            if (step.hasUserGesture) return false
            val stepSegment = PocPolicy.groupSegment(step.url)
            val facebookMove = step.isRedirect || step.viaHistory
            if (stepSegment == segment && facebookMove) return true
            if (stepSegment != approvedId && !facebookMove) return false
        }
        return false
    }

    fun describe(assessment: GroupAssessment): String = buildString {
        appendLine("Diagnoza grupy (zatwierdzona: ${PocPolicy.APPROVED_GROUP_ID})")
        assessment.reasons.forEach { appendLine("• $it") }
        append(
            when (assessment.verdict) {
                GroupVerdict.APPROVED_NUMERIC -> "Wynik: zatwierdzona grupa (adres numeryczny)."
                GroupVerdict.SAME_GROUP_EVIDENCE -> "Wynik: DOWÓD ALIASU. Facebook wskazuje ten sam numer grupy i sam przekierował adres. Skan pozostaje zablokowany do czasu ręcznego zatwierdzenia aliasu w kolejnej wersji."
                GroupVerdict.DIFFERENT_GROUP -> "Wynik: INNA GRUPA (${assessment.strongIds.joinToString()}). STOP pozostaje. Użyj „Wróć do grupy”."
                GroupVerdict.INSUFFICIENT -> "Wynik: BRAK DOWODU. STOP pozostaje. Otwórz grupę przyciskiem „Otwórz grupę” (bez klikania w stronie) i powtórz diagnozę."
            },
        )
    }
}
