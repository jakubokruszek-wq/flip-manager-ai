package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject

/** Only bounded aggregate counts, never MAIN body/record data, cross the native port. */
object MainTransportProtocol {
    val keys = listOf("installed", "fetchBodies", "xhrBodies", "bytes", "completed", "exactIds", "duplicates", "textRecords", "authorRecords", "imageRecords", "priceSignals", "areaSignals", "oversize", "errors", "limitSkipped", "scrollSteps", "scrollMoves")
    fun report(reply: JSONObject, nonce: String): String? {
        if (reply.keys().asSequence().toSet() != setOf("type", "nonce", "status", "counts") || reply.optString("type") != "mainTransportResult" || reply.optString("nonce") != nonce) return null
        val status=reply.optString("status")
        if (status !in setOf("OK", "STOP", "BUSY", "UNSUPPORTED")) return null
        val c=reply.optJSONObject("counts") ?: return null
        if (c.keys().asSequence().toSet() != keys.toSet() || keys.any { c.opt(it) !is Int || c.getInt(it) !in 0..(if (it=="bytes") 2097152 else 2000) }) return null
        if (c.getInt("installed") !in 0..1 || (status=="OK" && c.getInt("installed")!=1)) return null
        if (status!="OK" && keys.any { c.getInt(it)!=0 }) return null
        if (c.getInt("completed")>8 || c.getInt("completed")!=c.getInt("fetchBodies")+c.getInt("xhrBodies") || c.getInt("exactIds")>20) return null
        if (listOf("textRecords","authorRecords","imageRecords","priceSignals","areaSignals").any { c.getInt(it)>c.getInt("exactIds") }) return null
        if (c.getInt("scrollSteps")>5 || c.getInt("scrollMoves")>c.getInt("scrollSteps")) return null
        val verdict=when {
            status!="OK" -> status
            c.getInt("completed")==0 -> "Hook MAIN zainstalowany, brak obsługiwanych odpowiedzi fetch/XHR w tym oknie."
            c.getInt("exactIds")==0 -> "Odpowiedzi odczytane; brak rekordów z dokładnym linkiem zatwierdzonej grupy."
            else -> "Rozpoznano rekordy z dokładnym ID i linkiem grupy; kompletność ofert niepotwierdzona."
        }
        return "ROZSZERZENIE 0.3.8 • tylko lokalnie • $status\n$verdict\n" + keys.joinToString("\n") { "$it: ${c.getInt(it)}" } +
            "\nMechanizm desktopowy: kopia fetch i load XHR. Tylko odpowiedzi powstałe po nowej zgodzie, bez ponownego otwarcia grupy. Do 5 adaptacyjnych przewinięć. Parser w izolowanym tle rozszerzenia; bez publicznego mostu danych, zapisu treści/ID, uploadu, skanu i kolektora. Cena/metraż to sygnały heurystyczne. Beacon pozostaje bez odczytu."
    }
}
