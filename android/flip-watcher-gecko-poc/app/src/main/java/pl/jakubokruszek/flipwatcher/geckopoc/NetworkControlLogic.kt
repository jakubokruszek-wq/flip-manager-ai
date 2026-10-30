package pl.jakubokruszek.flipwatcher.geckopoc

/** Outcome of the listener control test. */
enum class ControlStatus { LISTENER_OK, LISTENER_NOT_OBSERVED, WRONG_TAB, TIMEOUT }

data class ControlResult(val status: ControlStatus, val counts: Map<String, Int>)

/**
 * "Test sieci GeckoView": proves on the device that the extension's
 * webRequest listener sees page-initiated requests of the armed tab and that
 * its counters reach Android. It runs in its OWN GeckoSession on the POC's
 * local 127.0.0.1 page (no login, no Facebook); the page fetches a marker
 * path every 300 ms while a short window is armed. A pass says nothing about
 * Facebook's own requests.
 */
object NetworkControl {
    /** Kotlin-side decision from the counters (the page's own verdict is not trusted). */
    fun classify(counts: Map<String, Int>?): ControlStatus {
        if (counts == null || counts["backgroundAnswered"] != 1) return ControlStatus.TIMEOUT
        val tab = counts["controlTab"] ?: 0
        return when {
            tab >= 2 -> ControlStatus.LISTENER_OK
            (counts["controlOtherTab"] ?: 0) + (counts["controlNoTab"] ?: 0) > 0 -> ControlStatus.WRONG_TAB
            else -> ControlStatus.LISTENER_NOT_OBSERVED
        }
    }

    fun describe(result: ControlResult): String = buildString {
        val c = result.counts
        appendLine("TEST SIECI GECKOVIEW — wynik: ${result.status}")
        appendLine("Lokalna strona 127.0.0.1 w osobnej sesji; bez Facebooka i bez logowania.")
        appendLine("Żądania kontrolne: ta karta ${c["controlTab"] ?: 0} • inna karta ${c["controlOtherTab"] ?: 0} • bez karty ${c["controlNoTab"] ?: 0}")
        appendLine("Licznik uzbrojony: ${yes(c["netArmed"])} • tło odpowiedziało: ${yes(c["backgroundAnswered"])} • webRequest: ${yes(c["apiWebRequest"])} • nasłuch zarejestrowany: ${yes(c["apiListener"])} • onCompleted: ${yes(c["apiOnCompleted"])} • odczyt treści: ${c["netBodyCapture"] ?: 0}")
        append(
            when (result.status) {
                ControlStatus.LISTENER_OK -> "Znaczenie: nasłuch GeckoView rejestruje żądania strony z właściwym tabId, a liczniki docierają do Androida. To NIE dowodzi niczego o ruchu Facebooka."
                ControlStatus.LISTENER_NOT_OBSERVED -> "Znaczenie: licznik działał, ale nie zobaczył żądań strony. Nasłuch sieci w tym GeckoView jest niewiarygodny — wyników sieci z Facebooka nie można interpretować."
                ControlStatus.WRONG_TAB -> "Znaczenie: żądania są widoczne, ale z innym tabId niż karta, która uzbroiła licznik. Pomiar karty Facebooka zaniża ruch do zera — wymaga poprawki mapowania kart."
                ControlStatus.TIMEOUT -> "Znaczenie: rozszerzenie lub tło nie odpowiedziało. Nie wiadomo nic o nasłuchu."
            },
        )
    }

    private fun yes(value: Int?) = if (value == 1) "tak" else "NIE"
}
