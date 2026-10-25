package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject

/** Persistable aggregate only. Selected post fields live only in the foreground activity. */
class DesktopSummary private constructor(val verdict:String,val reason:String,val offers:Int,val navigations:Int,val stats:Map<String,Int>){
    fun encode():String=JSONObject().put("verdict",verdict).put("reason",reason).put("offers",offers).put("navigations",navigations).put("stats",JSONObject(stats)).toString()
    fun report():String=buildString {
        appendLine("KOMPUTER 0.5.29 • tylko lokalnie • $verdict")
        appendLine("Komunikat powiadomień: wykryty ${stats.getValue("noticeDetected")} • zamknięty ${stats.getValue("noticeClosed")} • uprawnienia bez zmian")
        if(reason=="NOTICE_BLOCKED"){
            appendLine("Powód: NOTICE_BLOCKED")
            val causes=listOf("Starszy wynik nie zawiera szczegółów", "Nieznana nazwa i brak dokładnego opisu powiadomień", "Więcej niż jedno widoczne okno", "Okno zawiera formularz, post albo oznaki logowania/weryfikacji", "Brak pojedynczego przycisku zamknięcia", "Przycisk nie jest bezpiecznym Zamknij", "Przycisk niewidoczny lub nieaktywny", "Przycisk zasłonięty", "Przekroczony limit inspekcji okna", "Okno lub przycisk zmieniły się przed działaniem", "Zamknij nie usunęło okna", "Upłynął czas próby", "Utracony kontekst strony")
            appendLine("STOP: ${causes[stats.getValue("noticeReason")]} (kod ${stats.getValue("noticeReason")}).")
            appendLine("Okna: ${stats.getValue("noticeModals")} • widoczne: ${stats.getValue("noticeVisible")} • rozpoznanie: ${stats.getValue("noticeNameSource")} (0 brak, 1 etykieta, 2 nagłówek, 3 dokładny opis)")
            if(stats.getValue("noticeReason")==0)appendLine("Starsza wersja nie zapisała danych kontekstu ani przyczyny odmowy.") else appendLine("Kontekst grupy potwierdzony: ${stats.getValue("verified")} • tryb komputerowy: ${stats.getValue("desktop")} • nawigacje: $navigations/4")
            append("Nie zwrócono ofert i nie rozpoczęto przewijania. Pozostałe liczniki nie zostały pobrane. Dane tymczasowe odrzucono; bez uploadu.")
            return@buildString
        }
        if(stats.getValue("viewportGranted")==0)appendLine("Tryb bez miniatur i wejścia GeckoView; DOM i pola ofert pozostają aktywne.")
        if(stats.getValue("gestureRequested")==1){
            appendLine("Cel wskazany gestem: ${stats.getValue("gestureAnchored")} • gesty ${stats.getValue("gestureTouches")} • odmowy ${stats.getValue("gestureRejected")} • oczekiwanie ${stats.getValue("gestureWaitMs")} ms / 15000")
            appendLine("Kontynuacja wskazanego kontenera: ${stats.getValue("gestureScrollMoves")}/${stats.getValue("gestureScrollSteps")}")
            if(stats.getValue("gestureAnchored")==0)appendLine("UWAGA: nie wskazano kontenera rzeczywistym przesunięciem palca; automatyczne przewijanie nie rozpoczęło się.")
        }
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
        appendLine("Przewijanie GeckoView: ${stats.getValue("scrollNativeMoves")}/${stats.getValue("scrollNativeSteps")} • lokalne miniatury: ${stats.getValue("photoPreviews")} / próby klatek: ${stats.getValue("photoPreviewFrames")}")
        if(stats.getValue("viewportGranted")==1){
            appendLine("DOM zdjęć (powtórne obserwacje): IMG ${stats.getValue("photoRawImg")} • SVG ${stats.getValue("photoRawSvg")} • CSS ${stats.getValue("photoRawCss")}")
            appendLine("Ekstrakcja zdjęć — odmowy: właściciel ${stats.getValue("photoOwnerRejected")} • komentarz/wideo ${stats.getValue("photoScopeRejected")} • link ${stats.getValue("photoAnchorRejected")} • rozmiar ${stats.getValue("photoSizeRejected")} • źródło ${stats.getValue("photoSourceRejected")} • CSS niegotowe ${stats.getValue("photoCssUnready")}")
            appendLine("Ścieżki zdjęć (kandydaci): link wymagający dowodu sieci ${stats.getValue("photoNetworkAnchors")} • ramka SVG ${stats.getValue("photoSvgBounds")} • kafelek 60–79 px wymagający dowodu sieci ${stats.getValue("photoTinyBound")}")
            appendLine("Wybór zdjęć (powtórne obserwacje): karty dokładne ${stats.getValue("photoExactCards")} • sieciowe ${stats.getValue("photoNetworkCards")} • źródła ${stats.getValue("photoSources")} • wybrane ${stats.getValue("photoSelected")}")
            appendLine("Zdjęcia odrzucone: tożsamość ${stats.getValue("photoIdentityRejected")} • niezaładowane ${stats.getValue("photoUnready")} • geometria ${stats.getValue("photoGeometryRejected")} • zasłonięte ${stats.getValue("photoOccluded")} • już pobrane ${stats.getValue("photoAlreadyDone")}")
        }
        appendLine("Kanał viewport: moduł ${stats.getValue("viewportModule")} • zgoda ${stats.getValue("viewportGranted")} • gotowy ${stats.getValue("viewportReady")} • kod ${stats.getValue("viewportProbeCode")} (0 OK, 1 gate, 2 widok, 3 fokus okna, 4 brak ACK)")
        appendLine("Żądania wheel: ${stats.getValue("nativeRequests")} • odmowy ${stats.getValue("nativeRejected")} • brak ACK ${stats.getValue("nativeTimeout")} • brak punktu ${stats.getValue("pointMisses")} • posty z dowodem mediów ${stats.getValue("mediaBindingPosts")}")
        if(stats.getValue("viewportGranted")==1&&stats.getValue("viewportReady")==0)appendLine("UWAGA: kanał viewport nie potwierdził gotowości. Podgląd ofert nie potwierdza działania przewijania ani miniatur.")
        appendLine("Ostatni wybór punktu: próbki ${stats.getValue("pointProbes")} • puste ${stats.getValue("pointEmpty")} • ramka ${stats.getValue("pointFrame")} • obcy dokument ${stats.getValue("pointForeign")} • formularz ${stats.getValue("pointForm")}")
        appendLine("Odrzucenia punktów: dialog ${stats.getValue("pointDialog")} • komentarz ${stats.getValue("pointComment")} (commentable ${stats.getValue("pointCommentable")}) • menu/sidebar/header ${stats.getValue("pointChrome")} • widget ${stats.getValue("pointWidget")} • brak regionu ${stats.getValue("pointUnbound")}")
        appendLine("Cel z ruchu: ${stats.getValue("pointCache")} • bezpieczne karty ${stats.getValue("pointCacheCards")} • prostokąty ${stats.getValue("pointRects")}")
        appendLine("Geometria strony (CSS px): viewport ${stats.getValue("viewportWidth")}×${stats.getValue("viewportHeight")} • widoczny ${stats.getValue("visualWidth")}×${stats.getValue("visualViewportHeight")} • offset ${stats.getValue("visualOffsetX")}/${stats.getValue("visualOffsetY")} • skala×100 ${stats.getValue("visualScale100")} • pozostały zakres dokumentu ${stats.getValue("rootRemaining")}")
        appendLine("Przewijanie: do 30 s / ${if(stats.getValue("scrollFast")==1)60 else 30} prób; rytm DOM ${if(stats.getValue("scrollCadenceMs")==0)"niezapisany" else "${stats.getValue("scrollCadenceMs")} ms"}. Wspólne 60 s z ładowaniem może skrócić próbę. Maksymalnie 20 ID.")
        if(stats.getValue("scrollAtEnd")>0||stats.getValue("scrollStalls")>0)appendLine("UWAGA: osiągnięto koniec zakresu lub próba nie przesunęła strony; czekano na doładowanie. Brak nowych postów nie potwierdza kompletności.")
        if(stats.getValue("scrollSteps")==0&&stats.getValue("candidates")<20)appendLine("UWAGA: przewijanie nie rozpoczęło się — nie znaleziono dozwolonego kontenera z dostępnym zakresem przewijania. Wynik nie potwierdza kompletności grupy.")
        if(stats.getValue("scrollSteps")>0&&stats.getValue("scrollMoves")==0)appendLine("UWAGA: próby przewinięcia nie przesunęły kontenera; brak dalszych postów nie jest potwierdzony.")
        if(stats.getValue("limitSkipped")>0)appendLine("UWAGA: limit odpowiedzi wykorzystany; raport nie potwierdza odczytu wszystkich danych grupy.")
        appendLine("Limit 20 ID: nowe oferty mają pierwszeństwo przed niezakwalifikowanymi rekordami bez mediów. Nieodczytane posty mogą być dostępne w sekcji Do ręcznego sprawdzenia; brak OCR.")
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
            for(size in listOf(22,30,34,38,45,54,73,80,82,86,95,104,106))if(stored.keys().asSequence().toSet()==DesktopProtocol.statKeys.take(size).toSet())for(key in DesktopProtocol.statKeys.drop(size))stored.put(key,0)
            val stats=DesktopProtocol.parseStats(stored)?:return null
            if(verdict=="NO_GO"&&offers!=0)return null
            if(offers !in 0..20||nav !in 0..4||offers>stats.getValue("candidates")||(verdict=="CONDITIONAL_GO")!=(reason=="DONE"&&offers>0))return null
            DesktopSummary(verdict,reason,offers,nav,stats)
        }.getOrNull()
    }
}
