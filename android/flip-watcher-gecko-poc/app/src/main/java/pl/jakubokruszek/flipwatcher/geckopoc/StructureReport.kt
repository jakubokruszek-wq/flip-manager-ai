package pl.jakubokruszek.flipwatcher.geckopoc

/**
 * Turns the count-only structure diagnosis into a short, plain report that
 * answers, one by one: right document? post markup? permalinks? dynamic or
 * virtualized list? where (if anywhere) an exact post id exists. Pure Kotlin.
 */
object StructureReport {
    fun describe(d: StructureDiagnosis): String = buildString {
        val v = d.counts
        fun c(key: String) = v[key] ?: 0
        appendLine("DIAGNOZA POSTÓW — status: ${d.status}" + (d.verdict?.let { " • wynik: $it" } ?: ""))
        appendLine("Tylko liczby. Bez skanu, bez zapisu postów, zgoda jednorazowa bez zmian.")
        if (d.status != "GROUP_OK") return@buildString
        appendLine()
        appendLine("1) Dokument: ${c("ctxPointsInDocument")}/${c("ctxPointsSampled")} punktów ekranu należy do czytanego dokumentu • widoczny: ${yes(c("ctxVisible"))} • ten sam dokument od startu: ${yes(c("ctxSameDocumentAsLoad"))} • elementów: ${c("ctxElements")} • wysokość: ${c("ctxScrollHeightPx")} px")
        appendLine("2) Znaczniki: article ${c("roleArticles")}+${c("nativeArticles")} • feed ${c("roleFeeds")} • data-mcomponent ${c("mComponents")} (MContainer ${c("mContainers")}) • data-tracking-duration-id ${c("trackingIds")} • data-action-id ${c("actionIds")} • data-ft ${c("dataFt")} • role=button ${c("roleButtons")} • obrazy ${c("images")} (duże ${c("largeImages")})")
        appendLine("3) Permalinki: linki <a> ${c("anchors")} • do postów tej grupy ${c("anchorGroupPostLinks")} • obcych ${c("anchorForeignPostLinks")} • adresy postów w innych atrybutach ${c("attrPostLikeValues")} (tej grupy ${c("attrGroupPostLinks")})")
        appendLine("4) Zmiany DOM: od startu +${c("mutAddedTotal")}/−${c("mutRemovedTotal")} • ostatnie 10 s +${c("mutAdded10s")}/−${c("mutRemoved10s")} • wirtualizacja: ${if (c("virtualizationSuspected") == 1) "PRAWDOPODOBNA" else "nie widać"}")
        appendLine("5) Dane strony: skrypty ${c("inlineScripts")} (${c("inlineScriptKb")} KB) • post_id ${c("scriptKeyPostId")} • top_level_post_id ${c("scriptKeyTopLevel")} • story_fbid ${c("scriptKeyStoryFbid")} • permalinki grupy ${c("scriptGroupPermalinks")} • DOKŁADNE ID ${c("scriptExactIds")}")
        appendLine("6) Sieć: tylko liczniki zdarzeń, treść odpowiedzi NIE jest czytana (odczyt treści: ${c("netBodyCapture")}) • okno ${c("netWindowSec")} s • licznik uzbrojony: ${yes(c("netArmed"))} • odczytany: ${yes(c("netCountingActive"))} • żądań w oknie ${c("netReqTotal")}")
        appendLine("6a) Karta tej grupy (${c("netReqWithTab")}): ${typeLine("netTab", ::c)}")
        appendLine("6a) Bez karty — service worker/przeglądarka, NIE przypisane do grupy (${c("netReqNoTab")}): ${typeLine("netNoTab", ::c)} • service worker steruje stroną: ${yes(c("swControlled"))}")
        if (d.requestPaths.isNotEmpty()) appendLine("6b) Ścieżki żądań: " + d.requestPaths.joinToString { "${it.first}×${it.second}" })
        appendLine("7) Dokładne ID postów: linki ${c("domExactIds")} • dane strony ${c("scriptExactIds")} • sieć: nie czytamy treści")
        if (d.attributeNames.isNotEmpty()) appendLine("Najczęstsze atrybuty: " + d.attributeNames.joinToString { "${it.first}×${it.second}" })
        appendLine("Atrybuty z długimi numerami: " + if (d.numericAttributes.isEmpty()) "brak" else d.numericAttributes.joinToString { "${it.first}×${it.second}" })
        appendLine()
        append(
            when (d.verdict) {
                "WRONG_DOCUMENT_OR_CONTEXT" -> "Wniosek: rozszerzenie czyta inny dokument niż widoczny ekran."
                "EXACT_IDS_AVAILABLE" -> "Wniosek: są dokładne ID postów tej grupy (potwierdzone permalinkiem w tych samych danych). Skan może je odczytać."
                "ID_KEYS_WITHOUT_EXACT_BINDING" -> "Wniosek: dane zawierają klucze ID, ale bez permalinku tej grupy w tym samym węźle. Nie przyjmujemy ich (brak dowodu tożsamości)."
                "NETWORK_NOT_OBSERVED_YET" -> "Wniosek: nasłuch działa, ale nie zarejestrował jeszcze odpowiedzi. Przewiń kilka postów i powtórz."
                "FEED_DATA_NOT_CAPTURED" -> "Wniosek: treść przychodzi siecią (6a/6b), a ani DOM, ani skrypty strony nie niosą ID posta. ID mogą być tylko w treści odpowiedzi, której celowo nie czytamy — NO_GO dla tej metody bez osobnej decyzji."
                "NO_POST_MARKUP" -> "Wniosek: brak jakichkolwiek znaczników postów w dokumencie."
                "NO_POST_IDS_IN_PAGE_DATA" -> "Wniosek: posty są w DOM, ale ani linki, ani dane strony, ani sieć nie niosą ID posta."
                else -> "Wniosek: brak."
            },
        )
    }

    private fun yes(value: Int) = if (value == 1) "tak" else "NIE"

    private val TYPE_LABELS = listOf(
        "MainFrame" to "strona", "SubFrame" to "ramki", "Xhr" to "XHR/fetch", "Script" to "skrypty", "Websocket" to "websocket",
        "Image" to "obrazy", "Media" to "media", "Ping" to "ping", "Beacon" to "beacon", "Other" to "inne",
    )

    private fun typeLine(prefix: String, c: (String) -> Int) = TYPE_LABELS.joinToString(" • ") { (key, label) -> "$label ${c(prefix + key)}" }
}
