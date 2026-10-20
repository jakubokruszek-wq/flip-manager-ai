package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject

/** Only bounded aggregate counts cross into Android. No response data is persisted. */
object ResponseProtocol {
    val keys = listOf("responseDocumentRead", "responseDocumentCompleted", "responseDocumentBytes", "responseDocumentJsonBlocks", "responseDocumentPermalinks","responseFastScroll", "responseScrollCadenceMs", "responseLoadMode", "responseLoadNavigation", "responseLoadVerified", "responseQueuedBodies", "responseTabFetch", "responseTabOther", "responseTabUnhandled", "responseAutoScroll", "responseScrollSteps", "responseScrollMoves", "responseObserved", "responseBoundTab", "responseOtherTab", "responseNoTab", "responseTabXhr", "responseFrameRejected", "responseHostRejected", "responseEndpointRejected", "responseMissingOrigin", "responseApiAvailable", "responseArmed", "responseRequestsSeen", "responseOriginRejected", "responseFiltered", "responseCompleted", "responseBytes", "responseOversize", "responseDecodeErrors", "responseStreamErrors", "responseLimitSkipped", "responseKeyPostId", "responseKeyStoryId", "responseExactIds", "responseDuplicateIds", "responseRecordsWithText", "responseRecordsWithAuthor", "responseRecordsWithImages", "responsePriceSignals", "responseAreaSignals", "responseStopped", "responseTypeDocument", "responseTypeSubFrame", "responseTypeScript", "responseTypeImage", "responseTypeImageSet", "responseTypeStylesheet", "responseTypeFont", "responseTypeMedia", "responseTypePing", "responseTypeBeacon", "responseTypeWebsocket", "responseTypeObject", "responseTypeObjectSubrequest", "responseTypeCspReport", "responseTypeSpeculative", "responseTypeManifest", "responseTypeXslt", "responseTypeUnknown", "responseDataEndpoints", "responseDataXhr", "responseDataFetch", "responseDataOther", "responseDataPing", "responseDataBeacon", "responseDataUnhandled", "responseDataEligiblePing", "responseDataEligibleBeacon", "responseDataEligibleUnhandled", "responseDataFrameRejected", "responseDataOriginRejected", "responseDataMissingOrigin", "responseAjaxBz", "responseAjaxOther", "responseDataPath", "responseBeaconRead", "responseBeaconFiltered", "responseBeaconCompleted", "responseBeaconBytes", "responseBeaconNoData")
    fun report(reply: JSONObject, nonce: String): String? {
        if (reply.optString("type") != "responseDiagnosisResult" || reply.optString("nonce") != nonce) return null
        if (reply.keys().asSequence().toSet() != setOf("type", "nonce", "status", "counts")) return null
        val status = reply.optString("status")
        if (status !in setOf("OK", "STOP", "UNSUPPORTED", "BUSY")) return null
        val counts = reply.optJSONObject("counts") ?: return null
        if (counts.keys().asSequence().toSet() != keys.toSet()) return null
        if (keys.any { counts.opt(it) !is Int || counts.getInt(it) !in 0..(if (it in setOf("responseBytes", "responseBeaconBytes", "responseDocumentBytes")) 2097152 else 2000) }) return null
        if (listOf("responseApiAvailable", "responseArmed", "responseStopped").any { counts.getInt(it) > 1 }) return null
        if (counts.getInt("responseFiltered") > 8 || counts.getInt("responseCompleted") > counts.getInt("responseFiltered") || counts.getInt("responseExactIds") > 20) return null
        if (listOf("responseRecordsWithText", "responseRecordsWithAuthor", "responseRecordsWithImages", "responsePriceSignals", "responseAreaSignals").any { counts.getInt(it) > counts.getInt("responseExactIds") }) return null
        if (counts.getInt("responseAutoScroll") !in 0..1 || counts.getInt("responseScrollSteps") > 5 || counts.getInt("responseScrollMoves") > counts.getInt("responseScrollSteps")) return null
        if (counts.getInt("responseAutoScroll") == 0 && counts.getInt("responseScrollSteps") != 0) return null
        if (listOf("responseLoadMode", "responseLoadNavigation", "responseLoadVerified").any { counts.getInt(it) > 1 } || counts.getInt("responseQueuedBodies") > 8) return null
        if (counts.getInt("responseLoadMode") == 0 && (counts.getInt("responseLoadNavigation") != 0 || counts.getInt("responseLoadVerified") != 0 || counts.getInt("responseQueuedBodies") != 0)) return null
        if (status == "OK" && counts.getInt("responseLoadMode") == 1 && (counts.getInt("responseLoadNavigation") != 1 || counts.getInt("responseLoadVerified") != 1)) return null
        if (counts.getInt("responseBeaconRead") !in 0..1) return null
        if (counts.getInt("responseBeaconRead") == 1 && counts.getInt("responseLoadMode") != 1) return null
        if (counts.getInt("responseBeaconRead") == 0 && listOf("responseBeaconFiltered", "responseBeaconCompleted", "responseBeaconBytes", "responseBeaconNoData").any { counts.getInt(it) != 0 }) return null
        if (counts.getInt("responseBeaconFiltered") > counts.getInt("responseFiltered") || counts.getInt("responseBeaconCompleted") > counts.getInt("responseCompleted") || counts.getInt("responseBeaconCompleted") > counts.getInt("responseBeaconFiltered") || counts.getInt("responseBeaconNoData") > counts.getInt("responseBeaconCompleted") || counts.getInt("responseBeaconBytes") > counts.getInt("responseBytes")) return null
        val document = counts.getInt("responseDocumentRead")
        if (document !in 0..1) return null
        if (document == 0 && listOf("responseDocumentCompleted", "responseDocumentBytes", "responseDocumentJsonBlocks", "responseDocumentPermalinks").any { counts.getInt(it) != 0 }) return null
        if (document == 1 && (counts.getInt("responseLoadMode") != 1 || counts.getInt("responseAutoScroll") != 0 || counts.getInt("responseBeaconRead") != 0)) return null
        if (counts.getInt("responseDocumentCompleted") > 1 || counts.getInt("responseDocumentCompleted") > counts.getInt("responseCompleted") || counts.getInt("responseDocumentBytes") > counts.getInt("responseBytes") || counts.getInt("responseDocumentJsonBlocks") > 64 || counts.getInt("responseDocumentPermalinks") > 20) return null
        if (document == 1 && counts.getInt("responseFiltered") > 1) return null
        if ((counts.getInt("responseDocumentJsonBlocks") > 0 || counts.getInt("responseDocumentPermalinks") > 0) && counts.getInt("responseDocumentCompleted") != 1) return null
        val documentSummary = keys.take(5).joinToString(", ") { "${it.removePrefix("responseDocument")}=${counts.getInt(it)}" }
        val beaconSummary = listOf("responseBeaconRead", "responseBeaconFiltered", "responseBeaconCompleted", "responseBeaconBytes", "responseBeaconNoData").joinToString(", ") { "${it.removePrefix("responseBeacon")}=${counts.getInt(it)}" }
        if (counts.getInt("responseFastScroll") !in 0..1) return null
        val cadence = counts.getInt("responseScrollCadenceMs")
        if (counts.getInt("responseAutoScroll") == 0 && (cadence != 0 || counts.getInt("responseFastScroll") != 0)) return null
        if (counts.getInt("responseAutoScroll") == 1 && cadence != (if (counts.getInt("responseFastScroll") == 1) 500 else 2000)) return null
        val dataTotal = counts.getInt("responseDataEndpoints")
        if (listOf("Xhr", "Fetch", "Other", "Ping", "Beacon", "Unhandled").any { counts.getInt("responseData$it") > dataTotal }) return null
        if (listOf("Ping", "Beacon", "Unhandled").any { counts.getInt("responseDataEligible$it") > counts.getInt("responseData$it") }) return null
        if (counts.getInt("responseDataMissingOrigin") > counts.getInt("responseDataOriginRejected")) return null
        if (listOf("responseAjaxBz", "responseAjaxOther", "responseDataPath", "responseDataFrameRejected", "responseDataOriginRejected").any { counts.getInt(it) > dataTotal }) return null
        val typeSummary = listOf("responseTypeDocument", "responseTypeSubFrame", "responseTypeScript", "responseTypeImage", "responseTypeImageSet", "responseTypeStylesheet", "responseTypeFont", "responseTypeMedia", "responseTypePing", "responseTypeBeacon", "responseTypeWebsocket", "responseTypeObject", "responseTypeObjectSubrequest", "responseTypeCspReport", "responseTypeSpeculative", "responseTypeManifest", "responseTypeXslt", "responseTypeUnknown").joinToString(", ") { "${it.removePrefix("responseType")}=${counts.getInt(it)}" }
        val dataSummary = listOf("responseDataEndpoints", "responseDataXhr", "responseDataFetch", "responseDataOther", "responseDataPing", "responseDataBeacon", "responseDataUnhandled", "responseDataEligiblePing", "responseDataEligibleBeacon", "responseDataEligibleUnhandled", "responseDataFrameRejected", "responseDataOriginRejected", "responseDataMissingOrigin").joinToString(", ") { "${it.removePrefix("responseData")}=${counts.getInt(it)}" }
        val routeSummary = listOf("responseAjaxBz", "responseAjaxOther", "responseDataPath").joinToString(", ") { "${it.removePrefix("response")}=${counts.getInt(it)}" }
        val transport = when {
            status != "OK" -> status
            document == 1 && counts.getInt("responseDocumentBytes") == 0 -> "DOKUMENT: BRAK DOSTARCZONYCH BAJTÓW; nie dowodzi pustej odpowiedzi. Możliwy cache lub ograniczenie filtra."
            document == 1 && counts.getInt("responseDocumentCompleted") == 0 -> "DOKUMENT NIEUKOŃCZONY; analiza rekordów niewykonana. Sprawdź limit i błędy."
            document == 1 && counts.getInt("responseExactIds") == 0 -> "DOKUMENT ODCZYTANY; brak potwierdzonych rekordów z ID. Linki liczone osobno."
            document == 1 -> "DOKUMENT: POTWIERDZONE ID w JSON; kompletność ofert niepotwierdzona."
            counts.getInt("responseObserved") == 0 -> "BRAK ZDARZEŃ w oknie; parser nie otrzymał danych."
            counts.getInt("responseBoundTab") == 0 -> "BRAK POWIĄZANIA Z KARTĄ; treści nie odczytano."
            counts.getInt("responseTabXhr") + counts.getInt("responseTabFetch") + counts.getInt("responseTabOther") + counts.getInt("responseBeaconRead") * counts.getInt("responseTypeBeacon") == 0 -> "BRAK XHR W KARCIE ani fetch/other. To blokada przed parserem; sprawdź typy i endpointy poniżej."
            counts.getInt("responseFiltered") == 0 -> "BRAK BEZPIECZNEJ ODPOWIEDZI; sprawdź liczniki odrzuceń."
            counts.getInt("responseBytes") == 0 && counts.getInt("responseBeaconCompleted") > 0 && counts.getInt("responseBeaconNoData") == counts.getInt("responseBeaconCompleted") -> "BEACON BEZ DOSTARCZONYCH BAJTÓW; nie rozstrzyga, czy odpowiedź serwera była pusta."
            counts.getInt("responseBytes") == 0 -> "BRAK ODCZYTANYCH BAJTÓW; sprawdź ukończenia i błędy."
            counts.getInt("responseExactIds") == 0 -> "DANE ODCZYTANE, BRAK POTWIERDZONYCH ID."
            else -> "POTWIERDZONE ID W ODCZYTANYCH DANYCH; kompletność ofert niepotwierdzona."
        }
        return "ODPOWIEDZI 0.3.9 • tylko lokalnie • $status\n" + "Dokument grupy: $documentSummary\nOcena transportu: $transport\n" + "Pozostałe typy zasobów (karta): $typeSummary\nEndpointy danych (metadane): $dataSummary\nKlasy ścieżek: $routeSummary\nOdczyt Beacon (osobna zgoda): $beaconSummary\n" + keys.drop(5).take(42).joinToString("\n") { "$it: ${counts.getInt(it)}" } +
            "\nID: dokładny identyfikator i permalink zatwierdzonej grupy z parsera rozszerzenia. Cena/metraż: sygnały heurystyczne. Beacon: odpowiedzi czytane tylko przy Read=1 i nowej zgodzie. Ping i pozostałe typy poza dotychczasową allowlistą: tylko metadane. Eligible oznacza zgodność karty/ramki/origin/ścieżki, nie zgodę na odczyt. Same liczniki nie potwierdzają kompletności ofert. UNSUPPORTED: API odpowiedzi niedostępne; STOP: przerwana próba. Brak skanu i zapisu treści."
    }
}
