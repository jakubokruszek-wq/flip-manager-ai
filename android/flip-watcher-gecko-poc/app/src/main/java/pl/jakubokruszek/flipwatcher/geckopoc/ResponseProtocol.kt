package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject

/** Only bounded aggregate counts cross into Android. No response data is persisted. */
object ResponseProtocol {
    val keys = listOf("responseApiAvailable", "responseArmed", "responseRequestsSeen", "responseOriginRejected", "responseFiltered", "responseCompleted", "responseBytes", "responseOversize", "responseDecodeErrors", "responseStreamErrors", "responseLimitSkipped", "responseKeyPostId", "responseKeyStoryId", "responseExactIds", "responseDuplicateIds", "responseRecordsWithText", "responseRecordsWithAuthor", "responseRecordsWithImages", "responsePriceSignals", "responseAreaSignals", "responseStopped")
    fun report(reply: JSONObject, nonce: String): String? {
        if (reply.optString("type") != "responseDiagnosisResult" || reply.optString("nonce") != nonce) return null
        if (reply.keys().asSequence().toSet() != setOf("type", "nonce", "status", "counts")) return null
        val status = reply.optString("status")
        if (status !in setOf("OK", "STOP", "UNSUPPORTED", "BUSY")) return null
        val counts = reply.optJSONObject("counts") ?: return null
        if (counts.keys().asSequence().toSet() != keys.toSet()) return null
        if (keys.any { counts.opt(it) !is Int || counts.getInt(it) !in 0..(if (it == "responseBytes") 2097152 else 2000) }) return null
        if (listOf("responseApiAvailable", "responseArmed", "responseStopped").any { counts.getInt(it) > 1 }) return null
        if (counts.getInt("responseFiltered") > 8 || counts.getInt("responseCompleted") > counts.getInt("responseFiltered") || counts.getInt("responseExactIds") > 20) return null
        if (listOf("responseRecordsWithText", "responseRecordsWithAuthor", "responseRecordsWithImages", "responsePriceSignals", "responseAreaSignals").any { counts.getInt(it) > counts.getInt("responseExactIds") }) return null
        return "ODPOWIEDZI 0.2.9 • tylko lokalnie • $status\n" + keys.joinToString("\n") { "$it: ${counts.getInt(it)}" } +
            "\nID: dokładny identyfikator i permalink zatwierdzonej grupy z parsera rozszerzenia. Cena/metraż: sygnały heurystyczne. Same liczniki nie potwierdzają kompletności ofert. UNSUPPORTED: API odpowiedzi niedostępne; STOP: przerwana próba. Brak skanu i zapisu treści."
    }
}
