package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject

/** Only bounded aggregate counts cross into Android. No response data is persisted. */
object ResponseProtocol {
    val keys = listOf("responseObserved", "responseBoundTab", "responseOtherTab", "responseNoTab", "responseTabXhr", "responseFrameRejected", "responseHostRejected", "responseEndpointRejected", "responseMissingOrigin", "responseApiAvailable", "responseArmed", "responseRequestsSeen", "responseOriginRejected", "responseFiltered", "responseCompleted", "responseBytes", "responseOversize", "responseDecodeErrors", "responseStreamErrors", "responseLimitSkipped", "responseKeyPostId", "responseKeyStoryId", "responseExactIds", "responseDuplicateIds", "responseRecordsWithText", "responseRecordsWithAuthor", "responseRecordsWithImages", "responsePriceSignals", "responseAreaSignals", "responseStopped")
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
        val transport = when {
            status != "OK" -> status
            counts.getInt("responseObserved") == 0 -> "BRAK ZDARZEŃ w oknie; parser nie otrzymał danych."
            counts.getInt("responseBoundTab") == 0 -> "BRAK POWIĄZANIA Z KARTĄ; treści nie odczytano."
            counts.getInt("responseTabXhr") == 0 -> "BRAK XHR W KARCIE; widoczny ruch ma inne typy."
            counts.getInt("responseFiltered") == 0 -> "BRAK BEZPIECZNEJ ODPOWIEDZI; sprawdź liczniki odrzuceń."
            counts.getInt("responseBytes") == 0 -> "BRAK ODCZYTANYCH BAJTÓW; sprawdź ukończenia i błędy."
            counts.getInt("responseExactIds") == 0 -> "DANE ODCZYTANE, BRAK POTWIERDZONYCH ID."
            else -> "POTWIERDZONE ID W ODCZYTANYCH DANYCH; kompletność ofert niepotwierdzona."
        }
        return "ODPOWIEDZI 0.3.0 • tylko lokalnie • $status\n" + "Ocena transportu: $transport\n" + keys.joinToString("\n") { "$it: ${counts.getInt(it)}" } +
            "\nID: dokładny identyfikator i permalink zatwierdzonej grupy z parsera rozszerzenia. Cena/metraż: sygnały heurystyczne. Same liczniki nie potwierdzają kompletności ofert. UNSUPPORTED: API odpowiedzi niedostępne; STOP: przerwana próba. Brak skanu i zapisu treści."
    }
}
