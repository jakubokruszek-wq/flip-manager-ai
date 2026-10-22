package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject

/** Persistable aggregate only. Selected post fields live only in the foreground activity. */
class DesktopSummary private constructor(val verdict:String,val reason:String,val offers:Int,val navigations:Int,val stats:Map<String,Int>){
    fun encode():String=JSONObject().put("verdict",verdict).put("reason",reason).put("offers",offers).put("navigations",navigations).put("stats",JSONObject(stats)).toString()
    fun report():String=buildString {
        appendLine("KOMPUTER 0.5.8 • tylko lokalnie • $verdict")
        appendLine("Powód: $reason • tryb komputerowy: ${stats.getValue("desktop")} • nawigacje: $navigations/4")
        appendLine("Dokładne ID/permalinki: ${stats.getValue("candidates")} • kandydaci ofert po filtrach: $offers")
        appendLine("Odczyty rekordów DOM (powtórzenia): ${stats.getValue("dom")} • dane strony: ${stats.getValue("hydration")} • sieć: ${stats.getValue("network")}")
        appendLine("Żądania danych: ${stats.getValue("requests")} • filtry: ${stats.getValue("filtered")} • ukończone: ${stats.getValue("completed")} • bajty: ${stats.getValue("bytes")} • nowy kontekst: ${stats.getValue("verified")}")
        appendLine("Błędy strumienia/dekodowania: ${stats.getValue("streamErrors")}/${stats.getValue("decodeErrors")} • zbyt duże: ${stats.getValue("oversize")} • pominięte limitem: ${stats.getValue("limitSkipped")}")
        appendLine("Kontenery article: ${stats.getValue("articles")} • mobilne: ${stats.getValue("mobile")}")
        appendLine("Duplikaty: ${stats.getValue("duplicates")} • niejednoznaczności: ${stats.getValue("ambiguous")} • odrzucone: ${stats.getValue("rejected")}")
        if(stats.getValue("scrollSeen")>0){
            appendLine("Wybór przewijania (liczby bez DOM): sprawdzone ${stats.getValue("scrollSeen")} • bez zakresu ${stats.getValue("scrollNoRange")} • ukryte/niedozwolone ${stats.getValue("scrollHidden")} • poza ekranem ${stats.getValue("scrollOffscreen")} • niepowiązane ${stats.getValue("scrollUnbound")}")
            appendLine("Źródło: punkty ekranu ${stats.getValue("scrollHit")} • wybrano okno ${stats.getValue("scrollRoot")} / kontener ${stats.getValue("scrollInner")}")
        }
        appendLine("Przewinięcia: ${stats.getValue("scrollMoves")}/${stats.getValue("scrollSteps")} • odczyty skryptów: ${stats.getValue("scripts")}")
        appendLine("Okno przewijania: ${stats.getValue("scrollElapsedMs")} ms / 30000 • próby bez ruchu: ${stats.getValue("scrollStalls")} • oczekiwania bez celu: ${stats.getValue("scrollNoTarget")} • kontenery na końcu: ${stats.getValue("scrollAtEnd")}")
        appendLine("Wyrównanie ostatniego posta: ${stats.getValue("scrollTailMoves")}/${stats.getValue("scrollTailAttempts")} (limit 2, wliczone w ruchy) • fokus widziany: ${stats.getValue("pageFocused")} • widoczność: ${stats.getValue("pageVisible")}")
        appendLine("Przewijanie: do 30 s / 30 kroków; wspólne 60 s z ładowaniem może skrócić próbę. Przechowywane maksymalnie 20 ID.")
        if(stats.getValue("scrollAtEnd")>0||stats.getValue("scrollStalls")>0)appendLine("UWAGA: osiągnięto koniec zakresu lub próba nie przesunęła strony; czekano na doładowanie. Brak nowych postów nie potwierdza kompletności.")
        if(stats.getValue("scrollSteps")==0&&stats.getValue("candidates")<20)appendLine("UWAGA: przewijanie nie rozpoczęło się — nie znaleziono dozwolonego kontenera z dostępnym zakresem przewijania. Wynik nie potwierdza kompletności grupy.")
        if(stats.getValue("scrollSteps")>0&&stats.getValue("scrollMoves")==0)appendLine("UWAGA: próby przewinięcia nie przesunęły kontenera; brak dalszych postów nie jest potwierdzony.")
        if(stats.getValue("limitSkipped")>0)appendLine("UWAGA: limit odpowiedzi wykorzystany; raport nie potwierdza odczytu wszystkich danych grupy.")
        append("ID i permalink: dokładne. Pola oferty oraz kwalifikacja: heurystyki do sprawdzenia na stronie. CONDITIONAL_GO wymaga porównania przez operatora. Brak ID lub pól nie jest dowodem braku postów. Bez skanu produkcyjnego, uploadu i zapisu treści/ID. Ten raport zawiera tylko liczby. Pauza usuwa podgląd danych.")
    }
    companion object {
        fun eligible(row:DesktopRow)=row.usable&&row.intent in setOf("SELL_PROPERTY","UNKNOWN")&&(row.price!=null||row.area!=null||row.rooms!=null)
        fun create(reason:String,navigations:Int,reply:DesktopReply?=null):DesktopSummary {
            val valid=reason.takeIf{it in DesktopTrial.reasons}?:"PROTOCOL"
            val stats=reply?.stats?.let{DesktopProtocol.parseStats(JSONObject(it))}?:DesktopProtocol.emptyStats()
            if(reply!=null&&stats!=reply.stats)return DesktopSummary("NO_GO","PROTOCOL",0,navigations.coerceIn(0,4),DesktopProtocol.emptyStats())
            val offers=if(valid=="DONE"&&reply?.status=="OK")reply.rows.count(::eligible) else 0
            return DesktopSummary(if(offers>0)"CONDITIONAL_GO" else "NO_GO",if(valid=="DONE"&&offers==0)"EMPTY" else valid,offers,navigations.coerceIn(0,4),stats)
        }
        fun decode(raw:String?):DesktopSummary?=runCatching {
            if(raw==null||raw.length>4096)return null
            val j=JSONObject(raw);if(j.keys().asSequence().toSet()!=setOf("verdict","reason","offers","navigations","stats"))return null
            val verdict=j.getString("verdict");val reason=j.getString("reason")
            if(verdict !in setOf("CONDITIONAL_GO","NO_GO")||reason !in DesktopTrial.reasons||j.opt("offers") !is Int||j.opt("navigations") !is Int)return null
            val offers=j.getInt("offers");val nav=j.getInt("navigations");val stored=j.getJSONObject("stats")
            // Read old count-only history without changing/deleting it; fresh protocol stays strict.
            for(size in listOf(22,30,34))if(stored.keys().asSequence().toSet()==DesktopProtocol.statKeys.take(size).toSet())for(key in DesktopProtocol.statKeys.drop(size))stored.put(key,0)
            val stats=DesktopProtocol.parseStats(stored)?:return null
            if(verdict=="NO_GO"&&offers!=0)return null
            if(offers !in 0..20||nav !in 0..4||offers>stats.getValue("candidates")||(verdict=="CONDITIONAL_GO")!=(reason=="DONE"&&offers>0))return null
            DesktopSummary(verdict,reason,offers,nav,stats)
        }.getOrNull()
    }
}
