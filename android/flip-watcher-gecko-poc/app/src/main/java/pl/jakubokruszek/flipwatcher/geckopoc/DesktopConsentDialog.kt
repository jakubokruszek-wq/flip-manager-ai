package pl.jakubokruszek.flipwatcher.geckopoc

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.graphics.Rect
import android.text.TextUtils
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** One scrollable content area and an independent, always reachable consent footer. */
class DesktopConsentDialog(private val owner:Activity,uiContext:Context=owner,private val onAccept:(Selection)->Unit):Dialog(uiContext,android.R.style.Theme_Material_Light_Dialog_NoActionBar){
    data class Selection(val gesture:Boolean,val extended:Boolean)
    private fun dp(n:Int)=(n*context.resources.displayMetrics.density).toInt()
    private var accepted=false
    init {
        setOwnerActivity(owner);setCanceledOnTouchOutside(false)
        val root=LinearLayout(context).apply{orientation=LinearLayout.VERTICAL;setPadding(dp(12),dp(12),dp(12),dp(12))}
        val title=TextView(context).apply{text="Próba lokalna";textSize=20f;maxLines=2;ellipsize=TextUtils.TruncateAt.END;setTypeface(typeface,android.graphics.Typeface.BOLD)}
        root.addView(title,LinearLayout.LayoutParams(-1,-2))
        val body=ScrollView(context).apply{tag="poc.desktop.consentBody";isFocusableInTouchMode=true}
        val content=LinearLayout(context).apply{orientation=LinearLayout.VERTICAL}
        content.addView(TextView(context).apply{text=SUMMARY;textSize=16f;setPadding(0,dp(8),0,dp(8))})
        val gesture=CheckBox(context).apply{text="Wskaż obszar jednym gestem";isChecked=true;tag="poc.desktop.gesture";textSize=16f}
        val extended=CheckBox(context).apply{text="Eksperymentalne miniatury i wejście GeckoView";isChecked=false;isEnabled=false;tag="poc.desktop.extended";textSize=16f}
        gesture.setOnCheckedChangeListener{_,checked->extended.isEnabled=!checked;if(checked)extended.isChecked=false}
        content.addView(gesture);content.addView(extended)
        val details=TextView(context).apply{text=DETAILS;textSize=16f;visibility=View.GONE;tag="poc.desktop.consentDetails"}
        val disclosure=Button(context).apply{text="Pełny zakres i prywatność";textSize=16f;tag="poc.desktop.consentDisclosure";setOnClickListener{details.visibility=if(details.visibility==View.GONE)View.VISIBLE else View.GONE;text=if(details.visibility==View.VISIBLE)"Ukryj szczegóły" else "Pełny zakres i prywatność"}}
        content.addView(disclosure);content.addView(details)
        body.addView(content,ViewGroup.LayoutParams(-1,-2));root.addView(body,LinearLayout.LayoutParams(-1,0,1f))
        // Footer is outside ScrollView. Full-width buttons also fit large text.
        val footer=LinearLayout(context).apply{orientation=LinearLayout.VERTICAL;setPadding(0,dp(8),0,0)}
        footer.addView(Button(context).apply{text="Zgadzam się";textSize=16f;minHeight=dp(48);tag="poc.desktop.consentAccept";setOnClickListener{if(!accepted){accepted=true;val choice=Selection(gesture.isChecked,extended.isChecked);dismiss();onAccept(choice)}}},LinearLayout.LayoutParams(-1,-2))
        footer.addView(Button(context).apply{text="Anuluj";textSize=16f;minHeight=dp(48);tag="poc.desktop.consentCancel";setOnClickListener{dismiss()}},LinearLayout.LayoutParams(-1,-2))
        root.addView(footer,LinearLayout.LayoutParams(-1,-2));setContentView(root)
    }
    override fun show(){
        super.show()
        val visible=Rect();owner.window.decorView.getWindowVisibleDisplayFrame(visible)
        val metrics=context.resources.displayMetrics
        val width=if(visible.width()>0)visible.width() else metrics.widthPixels
        val height=if(visible.height()>0)visible.height() else metrics.heightPixels
        window?.setLayout((width*.94f).toInt(),(height*.9f).toInt())
    }
    companion object {
        private const val SUMMARY="Nowa zgoda: odczyt postów i odpowiedzi sieciowych zatwierdzonej grupy, maks. 20 postów i 60 s.\n\nPo komunikacie TERAZ przesuń treść raz palcem. Aplikacja kontynuuje przewijanie do 30 s.\n\nPodgląd jest lokalny i tymczasowy. Zdjęcia domyślnie wyłączone. Nie odczytujemy danych logowania, cookies ani tokenów.\n\nPauza, logowanie/CAPTCHA, zmiana grupy lub wygaszenie kończą próbę."
        private const val DETAILS="Zakres: jedna zatwierdzona grupa, nowe otwarcie w standardowym trybie komputerowym GeckoView. Odczyt wyrenderowanego DOM, danych strony oraz odpowiedzi fetch/XHR/other: do 64 odpowiedzi, 2 MiB każda, 4 MiB łącznie. Nasłuch przed otwarciem. Bez odczytu Beacon, nagłówków i wysyłanych formularzy.\n\nWskazanie gestem: do 15 s oczekiwania po komunikacie TERAZ, w pierwotnych 60 s całej próby. Jeden rzeczywisty gest wskazuje kontener; bez wskazania automatyczne przewijanie nie rusza. Dane gestu chwilowo w RAM, bez zapisu współrzędnych w raporcie. Do 30 automatycznych kroków przez 30 s; wolne ładowanie może skrócić okno.\n\nPo wyłączeniu wskazania gestem pozostaje dotychczasowa pętla DOM. Oddzielna opcja eksperymentalna włącza oficjalne wejście kółka myszy przy zatrzymaniu DOM i lokalne miniatury. Do 3 widocznych zdjęć na post: chwilowy obraz widoku Gecko w RAM jest usuwany po wycięciu miniatur. Bez dodatkowego pobierania mediów, zapisu obrazów i adresów zdjęć w Androidzie.\n\nDokładne ID/permalinki, heurystyczne pola i kwalifikacja ofert. Pełne treści tylko przejściowo w ograniczonym RAM. Podgląd i miniatury znikają po pauzie lub zmianie kontekstu. Lokalnie pozostaje wyłącznie raport status/liczniki, bez ID i treści postów.\n\nBez uploadu, backendu i produkcyjnego kolektora. Stary limit skanu, historia testów offline, outbox i potwierdzenia nie są resetowane. Logowanie, CAPTCHA, CHECKPOINT, inna grupa lub utrata kontekstu kończą próbę. Tryb komputerowy pozostaje do zamknięcia sesji. Zgoda i wybór opcji nie są zapamiętywane."
    }
}
