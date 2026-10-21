package pl.jakubokruszek.flipwatcher.geckopoc

import java.text.NumberFormat
import java.util.Locale

/** Transient presentation only. Clipboard and persistence continue using aggregate report(). */
object DesktopPresentation {
    fun preview(report:String,rows:List<DesktopRow>,hasHistory:Boolean):String=buildString {
        val offers=rows.filter{DesktopSummary.eligible(it)}
        val format=NumberFormat.getNumberInstance(Locale.forLanguageTag("pl-PL")).apply{maximumFractionDigits=2}
        fun number(value:Number?)=value?.let{format.format(it)}?:"—"
        if(rows.isNotEmpty()){
            appendLine("KANDYDACI OFERT: ${offers.size} — do porównania z Facebookiem")
            appendLine("Pola są heurystyczne. Podgląd tylko w RAM; pauza usuwa szczegóły.")
            for((i,row) in offers.withIndex()){
                appendLine("\nKANDYDAT ${i+1}")
                appendLine("Cena: ${number(row.price)} zł • ${number(row.area)} m² • pokoje: ${number(row.rooms)}")
                appendLine("${row.district?:"—"} / ${row.neighborhood?:"—"} / ${row.street?:"—"} • zdjęcia: ${row.photos}")
                appendLine("ID: ${row.postId}\n${row.permalink}")
            }
            val other=rows.filterNot{DesktopSummary.eligible(it)}
            if(other.isNotEmpty()){
                appendLine("\nPOZOSTAŁE ROZPOZNANE POSTY: ${other.size} — nie zakwalifikowano jako kandydatów ofert")
                for(row in other)appendLine("ID: ${row.postId}\n${row.permalink}")
            }
        }else if(hasHistory){
            appendLine("BRAK SZCZEGÓŁÓW OFERT W PAMIĘCI")
            appendLine("Pozostał tylko raport liczbowy. Szczegóły nie są zapisywane ani odtwarzane po pauzie lub zmianie kontekstu. Aby uzyskać aktualny podgląd, uruchom nową próbę z nową zgodą i obejrzyj wynik przed opuszczeniem aplikacji.")
        }
        append("\nRAPORT TECHNICZNY — kopiowanie obejmuje tylko tę część\n\n$report")
    }
}
