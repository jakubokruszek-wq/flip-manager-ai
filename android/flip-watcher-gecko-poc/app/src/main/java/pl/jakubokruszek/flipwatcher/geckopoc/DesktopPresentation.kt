package pl.jakubokruszek.flipwatcher.geckopoc

import java.text.NumberFormat
import java.util.Locale

/** Transient presentation only. Clipboard and persistence continue using aggregate report(). */
object DesktopPresentation {
    fun priceLabel(row:DesktopRow)=if(row.priceSource=="DERIVED_FROM_PRICE_PER_M2")"Cena wyliczona z ceny za m²" else "Cena"
    fun reviewable(row:DesktopRow)=!DesktopSummary.eligible(row)&&row.intent in setOf("SELL_PROPERTY","UNKNOWN")&&row.qualification in setOf("NO_TEXT","MISSING_FIELDS","NOT_PROPERTY","CLASSIFIER")
    fun photos(count:Int)=if(count==0)"Zdjęcia: brak rozpoznanego obrazu; pełna liczba nieustalona." else "Rozpoznane zdjęcia/miniatury: $count; pełna liczba zdjęć nieustalona."

    fun explanation(row:DesktopRow):String=when(row.qualification){
        "NO_TEXT"->"Brak tekstu przypisanego do dokładnego ID; nie można ocenić oferty."
        "FOREIGN_CITY"->"Reguła lokalizacji wykryła inne miasto niż Łódź."
        "NOT_PROPERTY"->"Przypisany tekst nie spełnił reguł rozpoznania nieruchomości."
        "MISSING_FIELDS"->"Brak rozpoznanej ceny, powierzchni i liczby pokoi."
        "CONFLICT"->"Sprzeczne konkretne intencje w danych tego samego posta; nie wybrano jednej."
        else->when(row.intent){
            "BUY_PROPERTY"->"Rozpoznana prośba zakupu, a nie oferta sprzedaży."
            "RENT_OFFER"->"Rozpoznana oferta najmu, poza filtrem sprzedaży."
            "RENT_WANTED"->"Rozpoznane poszukiwanie najmu, poza filtrem sprzedaży."
            "SERVICE"->"Rozpoznane ogłoszenie usługowe."
            "OTHER"->"Rozpoznana inna intencja niż sprzedaż nieruchomości."
            else->if(row.price==null&&row.area==null&&row.rooms==null)"Brak rozpoznanej ceny, powierzchni i liczby pokoi." else "Dane nie spełniły reguł klasyfikacji/lokalizacji; dokładnej przyczyny nie ustalono."
        }
    }

    fun preview(report:String,rows:List<DesktopRow>,hasHistory:Boolean):String=buildString {
        val offers=rows.filter{DesktopSummary.eligible(it)}
        val format=NumberFormat.getNumberInstance(Locale.forLanguageTag("pl-PL")).apply{maximumFractionDigits=2}
        fun number(value:Number?)=value?.let{format.format(it)}?:"—"
        if(rows.isNotEmpty()){
            appendLine("KANDYDACI OFERT: ${offers.size} — do porównania z Facebookiem")
            appendLine("Pola są heurystyczne. Podgląd tylko w RAM; pauza usuwa szczegóły.")
            for((i,row) in offers.withIndex()){
                appendLine("\nKANDYDAT ${i+1}")
                appendLine("${priceLabel(row)}: ${number(row.price)} zł • ${number(row.area)} m² • pokoje: ${number(row.rooms)}")
                appendLine("${row.district?:"—"} / ${row.neighborhood?:"—"} / ${row.street?:"—"} • ${photos(row.photos)}")
                appendLine("ID: ${row.postId}\n${row.permalink}")
            }
            val other=rows.filterNot{DesktopSummary.eligible(it)}
            if(other.isNotEmpty()){
                appendLine("\nPOZOSTAŁE ROZPOZNANE POSTY: ${other.size} — nie zakwalifikowano jako kandydatów ofert")
                for(row in other){
                    appendLine("\nPowód: ${explanation(row)}")
                    appendLine("Dostępne pola — cena: ${number(row.price)} zł • ${number(row.area)} m² • pokoje: ${number(row.rooms)}")
                    appendLine("ID: ${row.postId}\n${row.permalink}")
                }
            }
        }else if(hasHistory){
            appendLine("BRAK SZCZEGÓŁÓW OFERT W PAMIĘCI")
            appendLine("Pozostał tylko raport liczbowy. Szczegóły nie są zapisywane ani odtwarzane po pauzie lub zmianie kontekstu. Aby uzyskać aktualny podgląd, uruchom nową próbę z nową zgodą i obejrzyj wynik przed opuszczeniem aplikacji.")
        }
        append("\nRAPORT TECHNICZNY — kopiowanie obejmuje tylko tę część\n\n$report")
    }
}
