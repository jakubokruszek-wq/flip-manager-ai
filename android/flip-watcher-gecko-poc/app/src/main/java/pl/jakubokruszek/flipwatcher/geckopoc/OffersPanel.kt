package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.text.NumberFormat
import java.util.Locale

/** Cards are RAM-only. Erase text and listeners even from detached views held by old callbacks. */
class OffersPanel(context:Context,private val onOpen:(DesktopRow)->Unit,private val onReport:()->Unit):ScrollView(context){
    private val content=LinearLayout(context).apply{orientation=LinearLayout.VERTICAL;isSaveEnabled=false}
    init{tag="poc.offers";isSaveEnabled=false;addView(content)}
    private fun erase(view:View){
        view.setOnClickListener(null);view.contentDescription=null;view.tag=null
        if(view is TextView)view.text=""
        if(view is ViewGroup)for(i in 0 until view.childCount)erase(view.getChildAt(i))
    }
    fun showRows(rows:List<DesktopRow>,notice:String?=null){
        erase(content);content.removeAllViews()
        val dp=resources.displayMetrics.density
        content.setPadding((12*dp).toInt(),(8*dp).toInt(),(12*dp).toInt(),(12*dp).toInt())
        fun label(text:String,size:Float=16f)=TextView(context).apply{this.text=text;textSize=size;isSaveEnabled=false;setPadding(0,6,0,6)}
        val offers=rows.filter{DesktopSummary.eligible(it)}
        content.addView(label("Oferty (${offers.size})",22f).apply{setTypeface(null,Typeface.BOLD)})
        content.addView(label("Kandydaci do porównania z postem. Lista tylko w pamięci; opuszczenie aplikacji usuwa szczegóły.",14f))
        if(offers.isEmpty())content.addView(label(notice?:"Brak ofert w pamięci. Uruchom nową próbę komputerową z nową zgodą. Zapisany raport zawiera tylko liczby."))
        val format=NumberFormat.getNumberInstance(Locale.forLanguageTag("pl-PL")).apply{maximumFractionDigits=2}
        fun number(n:Number?)=n?.let{format.format(it)}?:"—"
        for((i,row) in offers.withIndex()){
            val card=LinearLayout(context).apply{
                tag="poc.offer.card.${row.postId}";orientation=LinearLayout.VERTICAL;isSaveEnabled=false
                setPadding((12*dp).toInt(),(10*dp).toInt(),(12*dp).toInt(),(10*dp).toInt());setBackgroundColor(Color.WHITE)
                layoutParams=LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT).apply{bottomMargin=(12*dp).toInt()}
            }
            card.addView(label("Oferta ${i+1}",18f).apply{setTypeface(null,Typeface.BOLD)})
            card.addView(label("Cena: ${number(row.price)} zł",22f))
            card.addView(label("${number(row.area)} m² • pokoje: ${number(row.rooms)}"))
            card.addView(label(listOfNotNull(row.district,row.neighborhood,row.street).joinToString(" / ").ifEmpty{"Lokalizacja: —"}))
            card.addView(label("Rozpoznane zdjęcia: ${row.photos}",14f))
            card.addView(label("ID: ${row.postId}",12f))
            val link=OfferLinks.validated(row)
            card.addView(label(link?:"Brak bezpiecznego linku",14f).apply{
                tag="poc.offer.link.${row.postId}";setTextColor(Color.rgb(20,80,180));isClickable=link!=null
                if(link!=null)setOnClickListener{onOpen(row)}
            })
            card.addView(Button(context).apply{
                tag="poc.offer.open.${row.postId}";text="Otwórz post";isAllCaps=false;isEnabled=link!=null;isSaveEnabled=false
                if(link!=null)setOnClickListener{onOpen(row)}
            })
            content.addView(card)
        }
        content.addView(label("Link otwiera Facebooka lub przeglądarkę poza POC. Przed otwarciem lista jest czyszczona. Bez skanu i uploadu.",13f))
        content.addView(Button(context).apply{tag="poc.offers.report";text="Raport i powody pozostałych postów";isAllCaps=false;isSaveEnabled=false;setOnClickListener{onReport()}})
        scrollTo(0,0)
    }
}
