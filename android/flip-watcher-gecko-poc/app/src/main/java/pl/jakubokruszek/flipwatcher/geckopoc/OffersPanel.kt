package pl.jakubokruszek.flipwatcher.geckopoc

import android.app.AlertDialog
import android.text.InputType
import android.widget.EditText
import android.widget.CheckBox
import android.widget.Spinner
import android.widget.ArrayAdapter
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

/** Erase detached view callbacks; the private archive is managed separately from live browser state. */
class OffersPanel(context:Context,private val onOpen:(DesktopRow)->Unit,private val onReport:()->Unit,private val onEnrich:(()->Unit)?=null,private val onOcr:(()->Unit)?=null,private val ocrAvailable:(String)->Boolean={false},private val ocrResult:(String)->DesktopRow?={null},private val onDelete:(()->Unit)?=null,private val onSavedOcr:(()->Unit)?=null,private val savedCrops:()->Int={0},private val onInspect:((DesktopRow)->Unit)?=null,private val onPhotos:(()->Unit)?=null,private val photoAvailable:(String)->Boolean={false}):ScrollView(context){
    private var filter=OfferFilter()
    private var filterDialog:AlertDialog?=null
    private val content=LinearLayout(context).apply{orientation=LinearLayout.VERTICAL;isSaveEnabled=false}
    init{tag="poc.offers";isSaveEnabled=false;addView(content)}
    private fun erase(view:View){
        view.setOnClickListener(null);view.contentDescription=null;view.tag=null
        if(view is TextView)view.text=""
        if(view is ImageView)view.setImageDrawable(null)
        if(view is ViewGroup)for(i in 0 until view.childCount)erase(view.getChildAt(i))
    }
    private fun numberFormat(value:Number?)=value?.let{NumberFormat.getNumberInstance(Locale.forLanguageTag("pl-PL")).apply{maximumFractionDigits=2}.format(it)}?:"—"
    fun showRows(rows:List<DesktopRow>,notice:String?=null,thumbnails:(String)->List<Bitmap> = {emptyList()},archived:Boolean=false){
        filterDialog?.dismiss();filterDialog=null
        if(rows.isEmpty())filter=OfferFilter()
        erase(content);content.removeAllViews()
        val dp=resources.displayMetrics.density
        content.setPadding((12*dp).toInt(),(8*dp).toInt(),(12*dp).toInt(),(12*dp).toInt())
        fun label(text:String,size:Float=16f)=TextView(context).apply{this.text=text;textSize=size;isSaveEnabled=false;setPadding(0,6,0,6)}
        val visible=rows.filter{filter.matches(it)}
        val offers=visible.filter{DesktopSummary.eligible(it)}
        content.addView(label("Oferty (${offers.size})",22f).apply{setTypeface(null,Typeface.BOLD)})
        content.addView(Button(context).apply{
            tag="poc.offers.filters";text="Filtry: ${visible.size}/${rows.size} postów • ${filter.section.label}";isAllCaps=false;isSaveEnabled=false
            setOnClickListener{showFilters{showRows(rows,notice,thumbnails,archived)}}
        })
        if(filter!=OfferFilter())content.addView(Button(context).apply{
            text="Wyczyść filtry";isAllCaps=false;isSaveEnabled=false
            setOnClickListener{filter=OfferFilter();showRows(rows,notice,thumbnails,archived)}
        })
        content.addView(label("Filtry zmieniają tylko widok. Uzupełnianie i OCR obejmują całą zachowaną listę. Sugestie OCR nie są używane do filtrowania.",13f))
        if(visible.isEmpty()&&rows.isNotEmpty())content.addView(label("Żaden post nie pasuje do filtrów. Zmień lub wyczyść filtry; zachowane posty nie zostały usunięte."))
        val photoCandidates=rows.filter{DesktopSummary.eligible(it)||DesktopPresentation.reviewable(it)}
        if(onPhotos!=null&&photoCandidates.isNotEmpty()){
            val missing=photoCandidates.count{!photoAvailable(it.postId)}
            content.addView(Button(context).apply{
                tag="poc.photos.collect";text="Uzupełnij zdjęcia ofert ($missing)";isAllCaps=false;isSaveEnabled=false
                setOnClickListener{onPhotos.invoke()}
            })
            content.addView(label("Ze zdjęciem: ${photoCandidates.size-missing}/${photoCandidates.size}. Najpierw rozpoznane oferty bez zdjęcia. Zapis lokalny, OCR osobno.",14f))
        }
        if(onSavedOcr!=null)content.addView(Button(context).apply{
            tag="poc.saved.ocr";text="OCR zapisanych zdjęć (${savedCrops()})";isAllCaps=false;isEnabled=savedCrops()>0
            setOnClickListener{onSavedOcr.invoke()}
        })
        fun inspect(parent:LinearLayout,row:DesktopRow){if(onInspect!=null)parent.addView(Button(context).apply{
            tag="poc.photo.inspect.${row.postId}";text="Sprawdź zdjęcie tego posta";isAllCaps=false
            setOnClickListener{onInspect.invoke(row)}
        })}
        val reviewCount=rows.count{DesktopPresentation.reviewable(it)}
        if(onEnrich!=null&&reviewCount>0)content.addView(Button(context).apply{
            tag="poc.review.enrich";text="Uzupełnij do ręcznego sprawdzenia ($reviewCount)";isAllCaps=false;isSaveEnabled=false;setOnClickListener{onEnrich.invoke()}
        })
        if(reviewCount>0)content.addView(label("Do sprawdzenia — obraz do OCR: ${rows.count{DesktopPresentation.reviewable(it)&&ocrAvailable(it.postId)}}/$reviewCount. Brak obrazu oznacza brak przechwycenia, nie brak danych.",14f))
        if(!archived&&onOcr!=null&&(reviewCount>0||rows.any{DesktopSummary.eligible(it)&&ocrAvailable(it.postId)}))content.addView(Button(context).apply{
            tag="poc.ocr.start";text=if(reviewCount>0)"OCR + uzupełnij brakujące dane" else "Odczytaj dane ze zdjęć (OCR)";isAllCaps=false;isSaveEnabled=false;setOnClickListener{onOcr.invoke()}
        })
        fun addOcr(parent:LinearLayout,id:String){ocrResult(id)?.let{r->
            parent.addView(label("OCR — DO SPRAWDZENIA. Dane ze zdjęcia, oddzielone od danych tekstowych posta.",15f).apply{tag="poc.ocr.result.$id";setTextColor(Color.rgb(145,75,0))})
            parent.addView(label("${DesktopPresentation.priceLabel(r)} (OCR): ${numberFormat(r.price)} zł • ${numberFormat(r.area)} m² • pokoje: ${r.rooms?:"—"}",16f))
            parent.addView(label(listOfNotNull(r.district,r.neighborhood,r.street).joinToString(" / ").ifEmpty{"Lokalizacja OCR: —"},14f))
            parent.addView(label("Heurystyki; porównaj ze zdjęciem. ${DesktopPresentation.explanation(r)}",13f))
        }}
        if(notice!=null)content.addView(label(notice,14f))
        content.addView(label("Kandydaci do porównania z postem. Wynik jest zapisywany lokalnie; opuszczenie aplikacji nie kasuje bazy.",14f))
        if(offers.isEmpty())content.addView(label(notice?:if(rows.any{DesktopPresentation.reviewable(it)})"Brak automatycznie rozpoznanych ofert. Posty do ręcznego sprawdzenia znajdują się poniżej." else "Brak zachowanych ofert. Uruchom nowe wyszukiwanie z nową zgodą."))
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
            inspect(card,row)
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
        val review=visible.filter{DesktopPresentation.reviewable(it)}
        if(review.isNotEmpty()){
            content.addView(label("Do ręcznego sprawdzenia (${review.size})",22f).apply{tag="poc.offers.review"})
            content.addView(label("Te posty mają dokładny link, ale nie zostały rozpoznane jako oferty. Napisy na grafikach mogą być niedostępne jako tekst. Nowy OCR wymaga zgody i dostępnego wycinka zdjęcia; jego wyniki są oznaczone do sprawdzenia.",14f))
            for(row in review){
                addOcr(content,row.postId)
                inspect(content,row)
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
        val excluded=visible.filter{!DesktopSummary.eligible(it)&&!DesktopPresentation.reviewable(it)}
        if(excluded.isNotEmpty()){
            content.addView(label("Poza filtrem (${excluded.size})",18f))
            for((reason,items) in excluded.groupBy{DesktopPresentation.explanation(it)})content.addView(label("${items.size} × $reason",13f))
        }
        content.addView(label("Zapisane linki otwierają Facebooka lub przeglądarkę. Wynik pozostaje w lokalnej bazie; bez uploadu. Nowy odczyt strony wymaga aktywnej sesji i nowej zgody.",13f))
        content.addView(Button(context).apply{tag="poc.offers.report";text="Raport i powody pozostałych postów";isAllCaps=false;isSaveEnabled=false;setOnClickListener{onReport()}})
        if(onDelete!=null)content.addView(Button(context).apply{
            tag="poc.offers.delete";text="Kasuj bazę";isAllCaps=false;setOnClickListener{onDelete.invoke()}
        })
        scrollTo(0,0)
    }
    private fun showFilters(refresh:()->Unit){
        val form=LinearLayout(context).apply{orientation=LinearLayout.VERTICAL;isSaveEnabled=false;setPadding(24,12,24,12)}
        val section=Spinner(context).apply{
            isSaveEnabled=false;adapter=ArrayAdapter(context,android.R.layout.simple_spinner_dropdown_item,OfferFilter.Section.values().map{it.label})
            setSelection(filter.section.ordinal)
        };form.addView(section)
        fun field(hint:String,value:String,numeric:Boolean=true)=EditText(context).apply{
            this.hint=hint;isSaveEnabled=false;setSingleLine();setText(value)
            inputType=if(numeric)InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL else InputType.TYPE_CLASS_TEXT
            form.addView(this)
        }
        val minPrice=field("Cena od (zł)",filter.minPrice?.toString().orEmpty())
        val maxPrice=field("Cena do (zł)",filter.maxPrice?.toString().orEmpty())
        val minArea=field("Metraż od (m²)",filter.minArea?.toString().orEmpty())
        val maxArea=field("Metraż do (m²)",filter.maxArea?.toString().orEmpty())
        val rooms=field("Liczba pokoi",filter.rooms?.toString().orEmpty())
        val location=field("Dzielnica / osiedle / ulica",filter.location,false)
        val unknown=CheckBox(context).apply{text="Uwzględnij brak danych w wybranych kryteriach";isChecked=filter.includeUnknown;isSaveEnabled=false};form.addView(unknown)
        val scroll=ScrollView(context).apply{isSaveEnabled=false;addView(form)}
        val dialog=AlertDialog.Builder(context).setTitle("Filtry lokalnej listy").setView(scroll).setNegativeButton("Anuluj",null).setPositiveButton("Zastosuj",null).create()
        filterDialog=dialog
        dialog.setOnDismissListener{erase(form);if(filterDialog===dialog)filterDialog=null}
        dialog.setOnShowListener{dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener{
            fun read(field:EditText):Double? {
                val raw=field.text.toString().trim()
                if(raw.isEmpty())return null
                val value=raw.replace(',','.').toDoubleOrNull()
                if(value==null||!value.isFinite()||value<0){field.error="Podaj poprawną nieujemną liczbę";throw IllegalArgumentException()}
                return value
            }
            try{
                val lo=read(minPrice);val hi=read(maxPrice);val a=read(minArea);val b=read(maxArea);val r=read(rooms)
                if(lo!=null&&hi!=null&&lo>hi){maxPrice.error="Cena do musi być ≥ cenie od";return@setOnClickListener}
                if(a!=null&&b!=null&&a>b){maxArea.error="Metraż do musi być ≥ metrażowi od";return@setOnClickListener}
                if(r!=null&&(r<1||r>100||r%1.0!=0.0)){rooms.error="Podaj całkowitą liczbę pokoi 1–100";return@setOnClickListener}
                filter=OfferFilter(lo,hi,a,b,r?.toInt(),location.text.toString().trim(),unknown.isChecked,OfferFilter.Section.values()[section.selectedItemPosition])
                dialog.dismiss();refresh()
            }catch(_:IllegalArgumentException){/* Keep invalid input visible for correction. */}
        }}
        dialog.show()
    }

}
