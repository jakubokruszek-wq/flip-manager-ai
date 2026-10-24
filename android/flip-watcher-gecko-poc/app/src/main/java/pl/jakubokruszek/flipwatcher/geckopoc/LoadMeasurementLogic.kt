package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONArray
import org.json.JSONObject

enum class LoadStatus { PASS, PARTIAL, FAIL }

/** One page-load measurement of the approved group: counters only. */
data class LoadResult(
    val status: LoadStatus,
    val reason: String?,
    val armedBeforeNavigation: Boolean,
    val counts: Map<String, Int>,
    val dom: Map<String, Int>?,
    val requestPaths: List<Pair<String, Int>> = emptyList(),
)

/**
 * Protocol, status, report and verdict of "Zmierz otwarcie grupy" (pure Kotlin).
 * The background arms before loadUri, binds to the tab of the first approved
 * main_frame, freezes on login/checkpoint/CAPTCHA/other group/other host, and
 * returns counts once; see poc-adapter.js createLoadCounter.
 */
object LoadMeasurement {
    const val WINDOW_MS = 25_000
    val STOP_REASONS = setOf("LOGIN", "CHECKPOINT", "CAPTCHA", "OTHER_GROUP", "OTHER_HOST", "OTHER_PAGE")
    private val TYPES = listOf("MainFrame", "SubFrame", "Xhr", "Script", "Websocket", "Image", "Media", "Ping", "Beacon", "Other")

    val LOAD_FIELDS = listOf(
        "loadArmed", "loadBound", "loadMainFrames", "loadDocCompleted", "loadWindowSec", "loadBodyCapture",
        "loadPageTotal", "loadFbcdnTotal", "loadNoTab", "loadNoTabFbcdn", "loadOtherTab", "loadCompleted", "loadFromCache",
    ) + TYPES.map { "loadPage$it" } + TYPES.map { "loadFbcdn$it" }

    val DOM_FIELDS = listOf(
        "domGroupOk", "domElements", "domMutAdded", "domMutRemoved", "domSecondsSinceLoad", "domMComponents",
        "domExactIds", "scriptExactIds", "scriptIdKeys",
    )
    private val PATH = Regex("^/[A-Za-z0-9_.-]{0,24}$|^\\(inne\\)$")

    fun armRequest(nonce: String, groupId: String, windowMs: Int = WINDOW_MS): JSONObject = JSONObject()
        .put("type", "armLoad").put("nonce", nonce).put("accepted", JSONArray(listOf(groupId))).put("windowMs", windowMs.coerceIn(1_000, 30_000))

    fun readRequest(nonce: String): JSONObject = JSONObject().put("type", "readLoad").put("nonce", nonce)
    fun abortRequest(nonce: String): JSONObject = JSONObject().put("type", "abortLoad").put("nonce", nonce)

    fun parseArmed(reply: JSONObject?, nonce: String): Boolean =
        reply != null && reply.optString("type") == "armLoadResult" && reply.optString("nonce") == nonce && reply.optInt("armed") == 1

    data class Read(val counts: Map<String, Int>, val stopReason: String?, val paths: List<Pair<String, Int>>)

    /** Null unless the reply is the measurement armed with [nonce]. */
    fun parseRead(reply: JSONObject?, nonce: String): Read? {
        if (reply == null || reply.optString("type") != "readLoadResult" || reply.optString("nonce") != nonce || reply.optInt("found") != 1) return null
        val values = reply.optJSONObject("counts") ?: return null
        val counts = LOAD_FIELDS.associateWith { values.optInt(it, 0).coerceIn(0, 999_999) }
        val stop = reply.optString("stopReason").takeIf { it in STOP_REASONS }
        val array = reply.optJSONArray("requestPaths") ?: JSONArray()
        val paths = (0 until minOf(array.length(), 12)).mapNotNull { index ->
            val item = array.optJSONObject(index) ?: return@mapNotNull null
            val name = item.optString("name")
            if (PATH.matches(name)) name to item.optInt("count").coerceIn(0, 999_999) else null
        }
        return Read(counts, stop, paths)
    }

    fun parseDomStats(reply: JSONObject?, nonce: String): Map<String, Int>? {
        if (reply == null || reply.optString("type") != "loadDomStatsResult" || reply.optString("nonce") != nonce) return null
        val values = reply.optJSONObject("counts") ?: return null
        return DOM_FIELDS.associateWith { values.optInt(it, 0).coerceIn(0, 999_999) }
    }

    fun status(armed: Boolean, read: Read?, dom: Map<String, Int>?, failure: String? = null): LoadResult {
        fun fail(reason: String) = LoadResult(LoadStatus.FAIL, reason, armed, read?.counts.orEmpty(), dom, read?.paths.orEmpty())
        if (failure != null) return fail(failure)
        if (!armed) return fail("NOT_ARMED")
        if (read == null) return fail("READ_TIMEOUT")
        if (read.counts["loadBound"] != 1) return fail("MAIN_FRAME_NOT_SEEN")
        if (read.stopReason != null) return fail(read.stopReason)
        val documentDone = read.counts["loadDocCompleted"] == 1
        val complete = documentDone && dom?.get("domGroupOk") == 1
        val reason = when {
            complete -> null
            !documentDone -> "DOCUMENT_NOT_COMPLETED"
            else -> "DOM_STATS_UNAVAILABLE"
        }
        return LoadResult(if (complete) LoadStatus.PASS else LoadStatus.PARTIAL, reason, true, read.counts, dom, read.paths)
    }

    /** Facebook API/data requests of the page: not the document, scripts or images. */
    fun apiRequests(c: Map<String, Int>): Int =
        listOf("loadPageXhr", "loadPageWebsocket", "loadPageSubFrame", "loadPageOther", "loadPageBeacon", "loadPagePing").sumOf { c[it] ?: 0 }

    fun verdict(r: LoadResult): ArchitectureVerdictResult {
        val d = r.dom.orEmpty()
        val exact = (d["domExactIds"] ?: 0) + (d["scriptExactIds"] ?: 0)
        val api = apiRequests(r.counts)
        return when {
            r.status == LoadStatus.FAIL && r.reason == "LOGIN" -> ArchitectureVerdictResult(ArchitectureDecision.INCOMPLETE, "Facebook przekierował do logowania. Zaloguj się ręcznie i powtórz pomiar.")
            r.status == LoadStatus.FAIL && (r.reason == "CHECKPOINT" || r.reason == "CAPTCHA") -> ArchitectureVerdictResult(ArchitectureDecision.INCOMPLETE, "STOP: Facebook wymaga weryfikacji (${r.reason}). Nic nie jest obchodzone; pomiar zamrożony.")
            r.status == LoadStatus.FAIL -> ArchitectureVerdictResult(ArchitectureDecision.INCOMPLETE, "Pomiar nieudany (${r.reason}); werdykt niemożliwy.")
            exact > 0 -> ArchitectureVerdictResult(ArchitectureDecision.GO, "Załadowana strona zawiera $exact dokładnych ID postów z permalinkiem grupy.")
            api > 0 -> ArchitectureVerdictResult(ArchitectureDecision.NO_GO,
                "Przy otwarciu grupy Facebook pobrał $api żądań danych (API), a ani DOM, ani skrypty strony nie niosą ID posta. ID mogą być tylko w treści odpowiedzi, której ta architektura celowo nie czyta.")
            (d["scriptIdKeys"] ?: 0) > 0 -> ArchitectureVerdictResult(ArchitectureDecision.CONDITIONAL_GO,
                "Brak żądań API; dane przyszły w dokumencie i skryptach z kluczami ID, ale bez permalinku grupy. Jeden pomiar kształtu tych kluczy (tylko liczby) rozstrzygnie.")
            else -> ArchitectureVerdictResult(ArchitectureDecision.NO_GO,
                "Brak żądań API i brak kluczy ID: posty przyszły w dokumencie strony w formie bez identyfikatorów dostępnych dla rozszerzenia.")
        }
    }

    fun describe(r: LoadResult): String = buildString {
        val c = r.counts
        val d = r.dom
        fun n(key: String) = c[key] ?: 0
        val total = n("loadPageTotal") + n("loadFbcdnTotal")
        val api = apiRequests(c)
        appendLine("ZMIERZ OTWARCIE GRUPY — status: ${r.status}" + (r.reason?.let { " ($it)" } ?: ""))
        appendLine("Tylko liczniki zdarzeń sieci; treść, nagłówki, cookies i pełne adresy NIE są czytane (odczyt treści: ${n("loadBodyCapture")}). Bez skanu.")
        appendLine("Nasłuch uzbrojony przed nawigacją: ${if (r.armedBeforeNavigation) "tak" else "NIE"} • main_frame zatwierdzonej grupy: ${if (n("loadBound") == 1) "tak (${n("loadMainFrames")})" else "NIE"} • dokument załadowany: ${if (n("loadDocCompleted") == 1) "tak" else "NIE"} • okno ${n("loadWindowSec")} s")
        appendLine("Wszystkie żądania tej karty: $total = facebook.com ${n("loadPageTotal")} + fbcdn.net ${n("loadFbcdnTotal")}")
        appendLine("Żądania API/danych Facebooka (XHR/fetch, websocket, ramki, inne): $api" + if (api == 0 && total > 0) " — inny ruch był ($total), więc to NIE jest brak ruchu" else "")
        appendLine("facebook.com: dokument ${n("loadPageMainFrame")} • XHR/fetch ${n("loadPageXhr")} • skrypty ${n("loadPageScript")} • obrazy ${n("loadPageImage")} • ramki ${n("loadPageSubFrame")} • websocket ${n("loadPageWebsocket")} • inne ${n("loadPageOther") + n("loadPageMedia") + n("loadPagePing") + n("loadPageBeacon")}")
        appendLine("fbcdn.net: obrazy ${n("loadFbcdnImage")} • skrypty ${n("loadFbcdnScript")} • XHR/fetch ${n("loadFbcdnXhr")} • media ${n("loadFbcdnMedia")} • inne ${n("loadFbcdnOther") + n("loadFbcdnSubFrame")}")
        appendLine("Bez karty (NIE przypisane do grupy): ${n("loadNoTab")} + fbcdn ${n("loadNoTabFbcdn")} • inne karty (tylko licznik): ${n("loadOtherTab")}")
        appendLine("Zakończone odpowiedzi: ${n("loadCompleted")} • z pamięci podręcznej: ${n("loadFromCache")}")
        if (r.requestPaths.isNotEmpty()) appendLine("Ścieżki facebook.com: " + r.requestPaths.joinToString { "${it.first}×${it.second}" })
        if (d != null) appendLine("Strona po pomiarze: zatwierdzona grupa ${if (d["domGroupOk"] == 1) "tak" else "NIE"} • elementy ${d["domElements"]} • data-mcomponent ${d["domMComponents"]} • zmiany DOM +${d["domMutAdded"]}/−${d["domMutRemoved"]} w ${d["domSecondsSinceLoad"]} s • dokładne ID: linki ${d["domExactIds"]}, skrypty ${d["scriptExactIds"]} • klucze ID w skryptach ${d["scriptIdKeys"]}")
        else appendLine("Strona po pomiarze: brak odpowiedzi skryptu strony.")
        val v = verdict(r)
        appendLine()
        append("WERDYKT: ${v.decision} — ${v.reason}")
        if (v.decision == ArchitectureDecision.NO_GO) append("\n" + ArchitectureVerdict.ALTERNATIVES)
    }
}
