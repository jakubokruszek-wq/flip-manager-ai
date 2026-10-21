package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject

/** Fixed terminal-result schema. No link, post ID, page text, nonce or consent can be encoded. */
class ShareLinkResult private constructor(val status: String, val reason: String, val requests: Int, val confirmedIds: Int) {
    fun encode(): String = JSONObject().put("status", status).put("reason", reason).put("requests", requests).put("confirmedIds", confirmedIds).toString()
    fun report(): String = "LINK 0.4.3 • tylko lokalnie • $status\n" +
        "Wynik: $reason\n${descriptions.getValue(reason)}\nŻądania nawigacji: $requests/8\n" +
        "Potwierdzone ID z adresu zatwierdzonej grupy: $confirmedIds\n" +
        "Ostatnia zakończona próba. Raport zawiera wyłącznie status, powód i liczniki — bez linku, ID i treści posta. Potwierdzenie adresu nie potwierdza treści oferty. Bez skanu i uploadu."
    companion object {
        private val descriptions = mapOf(
            "EXACT_APPROVED_GROUP_LINK" to "Potwierdzono dokładny adres posta zatwierdzonej grupy.",
            "EXACT_APPROVED_ADDRESS_RELOADED" to "Sprawdzono dokładny adres zatwierdzonej grupy przez ponowne otwarcie i nowy dokument. Nie potwierdzono powiązania z linkiem udostępnienia ani treści lub istnienia oferty.",
            "RELOAD_INTERRUPTED" to "Przerwano jednorazowe sprawdzenie adresu: pojawiła się inna lub niezatwierdzona nawigacja.",
            "RELOAD_LIMIT" to "Adres zmienił się ponownie bez zatwierdzonego żądania. Druga próba otwarcia nie jest dozwolona.",
            "INVALID_INPUT_OR_NO_CONSENT" to "Nie rozpoczęto nawigacji: brak poprawnego wejścia lub nowej zgody.",
            "UNEXPECTED_NAVIGATION" to "Przerwano z powodu nieoczekiwanej nawigacji.",
            "VERIFICATION_OR_LOGIN" to "Przerwano przy logowaniu lub weryfikacji Facebooka.",
            "UNVERIFIED_DESTINATION" to "Adres docelowy nie przeszedł weryfikacji grupy lub obsługiwanego formatu.",
            "REDIRECT_LIMIT" to "Przekroczono limit przekierowań.",
            "CONTEXT_CHANGED" to "Zmienił się oczekiwany kontekst strony (raport starszej wersji).",
            "LOCATION_MISSING" to "Silnik zgłosił brak adresu dokumentu.",
            "LOCATION_BEFORE_REQUEST" to "Zmiana adresu nastąpiła przed zatwierdzonym żądaniem nawigacji.",
            "LOCATION_UNVERIFIED" to "Adres dokumentu nie jest tym samym linkiem udostępnienia ani dokładnym adresem posta zatwierdzonej grupy. Format lub grupa pozostają niezweryfikowane.",
            "LOCATION_WITHOUT_REQUEST" to "Adres ma dozwolony format, ale nie odpowiada ostatniemu zatwierdzonemu żądaniu. Brak potwierdzonego powiązania nawigacji.",
            "UNSAFE_DOCUMENT" to "Kontrola bezpieczeństwa strony przerwała próbę.",
            "PORT_LOST" to "Utracono połączenie z rozszerzeniem.",
            "DEADLINE" to "Upłynął limit czasu.",
            "PAUSED" to "Próba przerwana po opuszczeniu aplikacji lub wygaszeniu ekranu.",
            "SESSION_CLOSED" to "Próba przerwana przy zamknięciu sesji.",
            "MANUAL_NAVIGATION" to "Próba przerwana przez ręczną nawigację.",
            "LOAD_ERROR" to "Strona zgłosiła błąd ładowania.",
            "CANCELLED" to "Próba została anulowana.",
        )
        private fun validated(status: String, reason: String, requests: Int, ids: Int): ShareLinkResult? {
            if (status !in setOf("CONFIRMED", "STOP", "TIMEOUT") || reason !in descriptions || requests !in 0..8 || ids !in 0..1) return null
            val confirmedReason = reason in setOf("EXACT_APPROVED_GROUP_LINK", "EXACT_APPROVED_ADDRESS_RELOADED")
            if (status == "CONFIRMED" && (!confirmedReason || ids != 1 || requests < 1)) return null
            if (status != "CONFIRMED" && (ids != 0 || confirmedReason)) return null
            if (reason == "EXACT_APPROVED_ADDRESS_RELOADED" && requests < 2) return null
            if ((status == "TIMEOUT") != (reason == "DEADLINE")) return null
            return ShareLinkResult(status, reason, requests, ids)
        }
        fun snapshot(resolver: ShareLinkResolver): ShareLinkResult? = validated(resolver.status.name, resolver.reason, resolver.requests, if (resolver.status == ShareLinkResolver.Status.CONFIRMED) 1 else 0)
        fun decode(encoded: String?): ShareLinkResult? = runCatching {
            if (encoded == null || encoded.length > 512) return null
            val j = JSONObject(encoded)
            if (j.keys().asSequence().toSet() != setOf("status", "reason", "requests", "confirmedIds") || j.opt("status") !is String || j.opt("reason") !is String || j.opt("requests") !is Int || j.opt("confirmedIds") !is Int) return null
            validated(j.getString("status"), j.getString("reason"), j.getInt("requests"), j.getInt("confirmedIds"))
        }.getOrNull()
    }
}
