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
import android.widget.ImageView
import android.graphics.Bitmap
import java.text.NumberFormat
import java.util.Locale

/** Cards are RAM-only. Erase text and listeners even from detached views held by old callbacks. */
class OffersPanel(context:Context,private val onOpen:(DesktopRow)->Unit,private val onReport:()->Unit,private val onEnrich:(()->Unit)?=null,private val onOcr:(()->Unit)?=null,private val ocrAvailable:(String)->Boolean={false},private val ocrResult:(String)->DesktopRow?={null}):ScrollView(context){
    private val content=LinearLayout(context).apply{orientation=LinearLayout.VERTICAL;isSaveEnabled=false}
    init{tag="poc.offers";isSaveEnabled=false;addView(content)}
    private fun erase(view:View){
        view.setOnClickListener(null);view.contentDescription=null;view.tag=null
        if(view is TextView)view.text=""
        if(view is ImageView)view.setImageDrawable(null)
        if(view is ViewGroup)for(i in 0 until view.childCount)erase(view.getChildAt(i))
    }
    private fun numberFormat(value:Number?)=value?.let{NumberFormat.getNumberInstance(Locale.forLanguageTag("pl-PL")).apply{maximumFractionDigits=2}.format(it)}?:"—"
    fun showRows(rows:List<DesktopRow>,notice:String?=null,thumbnails:(String)->List<Bitmap> = {emptyList()}){
        erase(content);content.removeAllViews()
        val dp=resources.displayMetrics.density
        content.setPadding((12*dp).toInt(),(8*dp).toInt(),(12*dp).toInt(),(12*dp).toInt())
        fun label(text:String,size:Float=16f)=TextView(context).apply{this.text=text;textSize=size;isSaveEnabled=false;setPadding(0,6,0,6)}
        val offers=rows.filter{DesktopSummary.eligible(it)}
        content.addView(label("Oferty (${offers.size})",22f).apply{setTypeface(null,Typeface.BOLD)})
        val reviewCount=rows.count{DesktopPresentation.reviewable(it)}
        if(onEnrich!=null&&reviewCount>0)content.addView(Button(context).apply{
            tag="poc.review.enrich";text="Uzupełnij do ręcznego sprawdzenia ($reviewCount)";isAllCaps=false;isSaveEnabled=false;setOnClickListener{onEnrich.invoke()}
        })
        if(reviewCount>0)content.addView(label("Do sprawdzenia — obraz do OCR: ${rows.count{DesktopPresentation.reviewable(it)&&ocrAvailable(it.postId)}}/$reviewCount. Brak obrazu oznacza brak przechwycenia, nie brak danych.",14f))
        if(onOcr!=null&&(reviewCount>0||rows.any{DesktopSummary.eligible(it)&&ocrAvailable(it.postId)}))content.addView(Button(context).apply{
            tag="poc.ocr.start";text="Odczytaj dane ze zdjęć (OCR)";isAllCaps=false;isSaveEnabled=false;setOnClickListener{onOcr.invoke()}
        })
        fun addOcr(parent:LinearLayout,id:String){ocrResult(id)?.let{r->
            parent.addView(label("OCR — DO SPRAWDZENIA. Dane ze zdjęcia, oddzielone od danych tekstowych posta.",15f).apply{tag="poc.ocr.result.$id";setTextColor(Color.rgb(145,75,0))})
            parent.addView(label("${DesktopPresentation.priceLabel(r)} (OCR): ${numberFormat(r.price)} zł • ${numberFormat(r.area)} m² • pokoje: ${r.rooms?:"—"}",16f))
            parent.addView(label(listOfNotNull(r.district,r.neighborhood,r.street).joinToString(" / ").ifEmpty{"Lokalizacja OCR: —"},14f))
            parent.addView(label("Heurystyki; porównaj ze zdjęciem. ${DesktopPresentation.explanation(r)}",13f))
        }}
        if(notice!=null&&offers.isNotEmpty())content.addView(label(notice,14f))
        content.addView(label("Kandydaci do porównania z postem. Lista tylko w pamięci; opuszczenie aplikacji usuwa szczegóły.",14f))
        if(offers.isEmpty())content.addView(label(notice?:if(rows.any{DesktopPresentation.reviewable(it)})"Brak automatycznie rozpoznanych ofert. Posty do ręcznego sprawdzenia znajdują się poniżej." else "Brak ofert w pamięci. Uruchom nową próbę komputerową z nową zgodą. Zapisany raport zawiera tylko liczby."))
        val format=NumberFormat.getNumberInstance(Locale.forLanguageTag("pl-PL")).apply{maximumFractionDigits=2}
        fun number(n:Number?)=n?.let{format.format(it)}?:"—"
        for((i,row) in offers.withIndex()){
            val card=LinearLayout(context).apply{
                tag="poc.offer.card.${row.postId}";orientation=LinearLayout.VERTICAL;isSaveEnabled=false
                setPadding((12*dp).toInt(),(10*dp).toInt(),(12*dp).toInt(),(10*dp).toInt());setBackgroundColor(Color.WHITE)
                layoutParams=LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT).apply{bottomMargin=(12*dp).toInt()}
            }
            card.addView(label("Oferta ${i+1}",18f).apply{setTypeface(null,Typeface.BOLD)})
            card.addView(label("${DesktopPresentation.priceLabel(row)}: ${number(row.price)} zł",22f).apply{tag="poc.offer.price.${row.postId}"})
            card.addView(label("${number(row.area)} m² • pokoje: ${number(row.rooms)}"))
            card.addView(label(listOfNotNull(row.district,row.neighborhood,row.street).joinToString(" / ").ifEmpty{"Lokalizacja: —"}))
            card.addView(label(DesktopPresentation.completeness(row),14f).apply{tag="poc.offer.missing.${row.postId}"})
            card.addView(label(DesktopPresentation.source(row),12f))
            card.addView(label(DesktopPresentation.photos(row.photos),14f))
            val pictures=thumbnails(row.postId).filter{!it.isRecycled}.take(3)
            if(pictures.isEmpty())card.addView(label("Brak lokalnej miniatury — zdjęcie mogło nie być widoczne podczas próby.",13f))
            for((index,image) in pictures.withIndex())card.addView(ImageView(context).apply{
                tag="poc.offer.photo.${row.postId}.$index";isSaveEnabled=false;adjustViewBounds=true;scaleType=ImageView.ScaleType.FIT_CENTER
                contentDescription="Lokalna miniatura ${index+1}";setImageBitmap(image)
                layoutParams=LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,(180*dp).toInt())
            })
            addOcr(card,row.postId)
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
        val review=rows.filter{DesktopPresentation.reviewable(it)}
        if(review.isNotEmpty()){
            content.addView(label("Do ręcznego sprawdzenia (${review.size})",22f).apply{tag="poc.offers.review"})
            content.addView(label("Te posty mają dokładny link, ale nie zostały rozpoznane jako oferty. Napisy na grafikach mogą być niedostępne jako tekst. OCR wymaga osobnej zgody i dostępnego wycinka zdjęcia w RAM; jego wyniki są oznaczone do sprawdzenia.",14f))
            for(row in review){
                addOcr(content,row.postId)
                content.addView(label(DesktopPresentation.explanation(row),14f))
                content.addView(label("${DesktopPresentation.priceLabel(row)}: ${number(row.price)} zł • ${number(row.area)} m² • pokoje: ${number(row.rooms)}",16f).apply{tag="poc.review.fields.${row.postId}"})
                content.addView(label(listOfNotNull(row.district,row.neighborhood,row.street).joinToString(" / ").ifEmpty{"Lokalizacja: —"}))
                content.addView(label(DesktopPresentation.completeness(row),14f))
                content.addView(label(DesktopPresentation.source(row),12f))
                for((index,image) in thumbnails(row.postId).filter{!it.isRecycled}.take(3).withIndex())content.addView(ImageView(context).apply{
                    tag="poc.review.photo.${row.postId}.$index";isSaveEnabled=false;adjustViewBounds=true;scaleType=ImageView.ScaleType.FIT_CENTER
                    contentDescription="Lokalna miniatura nieocenionego posta ${index+1}";setImageBitmap(image)
                    layoutParams=LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,(180*dp).toInt())
                })
                val link=OfferLinks.validatedReview(row)
                if(link!=null)content.addView(Button(context).apply{
                    tag="poc.review.open.${row.postId}";text="Otwórz post do sprawdzenia";isAllCaps=false;isSaveEnabled=false
                    setOnClickListener{onOpen(row)}
                })
                content.addView(label(link?:"Brak bezpiecznego linku",14f).apply{
                    tag="poc.review.link.${row.postId}";setTextColor(Color.rgb(20,80,180));isClickable=link!=null
                    if(link!=null)setOnClickListener{onOpen(row)}
                })
            }
        }
        val excluded=rows.filter{!DesktopSummary.eligible(it)&&!DesktopPresentation.reviewable(it)}
        if(excluded.isNotEmpty()){
            content.addView(label("Poza filtrem (${excluded.size})",18f))
            for((reason,items) in excluded.groupBy{DesktopPresentation.explanation(it)})content.addView(label("${items.size} × $reason",13f))
        }
        content.addView(label("Posty do sprawdzenia otwierają się w karcie Facebook tej aplikacji. Pozostałe linki otwierają Facebooka lub przeglądarkę. Opuszczenie podglądu czyści dane; bez skanu i uploadu.",13f))
        content.addView(Button(context).apply{tag="poc.offers.report";text="Raport i powody pozostałych postów";isAllCaps=false;isSaveEnabled=false;setOnClickListener{onReport()}})
        scrollTo(0,0)
    }
}
