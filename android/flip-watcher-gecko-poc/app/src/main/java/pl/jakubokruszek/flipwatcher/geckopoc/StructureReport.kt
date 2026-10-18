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
        appendLine("6) Sieć: nasłuch ${if (c("netFilterAvailable") == 1) "aktywny" else "NIEDOSTĘPNY"} • odpowiedzi ${c("netResponses")} • zatrzymane ${c("netHeld")} (${c("netKb")} KB) • post_id ${c("netKeyPostId")} • top_level_post_id ${c("netKeyTopLevel")} • story_fbid ${c("netKeyStoryFbid")} • permalinki grupy ${c("netGroupPermalinks")} • DOKŁADNE ID ${c("netExactIds")}")
        appendLine("7) Dokładne ID postów: linki ${c("domExactIds")} • dane strony ${c("scriptExactIds")} • sieć ${c("netExactIds")}")
        if (d.attributeNames.isNotEmpty()) appendLine("Najczęstsze atrybuty: " + d.attributeNames.joinToString { "${it.first}×${it.second}" })
        appendLine()
        append(
            when (d.verdict) {
                "WRONG_DOCUMENT_OR_CONTEXT" -> "Wniosek: rozszerzenie czyta inny dokument niż widoczny ekran."
                "EXACT_IDS_AVAILABLE" -> "Wniosek: są dokładne ID postów tej grupy (potwierdzone permalinkiem w tych samych danych). Skan może je odczytać."
                "ID_KEYS_WITHOUT_EXACT_BINDING" -> "Wniosek: dane zawierają klucze ID, ale bez permalinku tej grupy w tym samym węźle. Nie przyjmujemy ich (brak dowodu tożsamości)."
                "NETWORK_NOT_OBSERVED_YET" -> "Wniosek: nasłuch działa, ale nie zarejestrował jeszcze odpowiedzi. Przewiń kilka postów i powtórz."
                "NO_POST_MARKUP" -> "Wniosek: brak jakichkolwiek znaczników postów w dokumencie."
                "NO_POST_IDS_IN_PAGE_DATA" -> "Wniosek: posty są w DOM, ale ani linki, ani dane strony, ani sieć nie niosą ID posta."
                else -> "Wniosek: brak."
            },
        )
    }

    private fun yes(value: Int) = if (value == 1) "tak" else "NIE"
}
