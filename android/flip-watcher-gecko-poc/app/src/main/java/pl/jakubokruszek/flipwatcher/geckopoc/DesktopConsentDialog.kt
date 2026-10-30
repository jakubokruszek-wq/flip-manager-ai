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
class DesktopConsentDialog(private val owner:Activity,uiContext:Context=owner,private val onAccept:(Boolean)->Unit):Dialog(uiContext,android.R.style.Theme_Material_Light_Dialog_NoActionBar){
    private fun dp(n:Int)=(n*context.resources.displayMetrics.density).toInt()
    private var accepted=false
    init {
        setOwnerActivity(owner);setCanceledOnTouchOutside(false)
        val root=LinearLayout(context).apply{orientation=LinearLayout.VERTICAL;setPadding(dp(12),dp(12),dp(12),dp(12))}
        val title=TextView(context).apply{text="Podgląd auto";textSize=20f;maxLines=2;ellipsize=TextUtils.TruncateAt.END;setTypeface(typeface,android.graphics.Typeface.BOLD)}
        root.addView(title,LinearLayout.LayoutParams(-1,-2))
        val body=ScrollView(context).apply{tag="poc.desktop.consentBody";isFocusableInTouchMode=true}
        val content=LinearLayout(context).apply{orientation=LinearLayout.VERTICAL}
        val autoPhotos=CheckBox(context).apply{tag="poc.desktop.autoPhotos";text="Automatycznie uzupełnij zdjęcia ofert (bez OCR)";isChecked=true;isSaveEnabled=false}
        content.addView(autoPhotos)
        content.addView(TextView(context).apply{text=SUMMARY;textSize=16f;setPadding(0,dp(8),0,dp(8))})
        content.addView(TextView(context).apply{text="Zaznaczenie obejmuje otwarcie zachowanych postów bez zdjęcia: najpierw rozpoznane oferty, potem kandydaci do ręcznego sprawdzenia. Do jednego widocznego zdjęcia na post, 20 postów i 3 minuty po wyszukaniu. Każde potwierdzone zdjęcie zapisuje się lokalnie przed następnym postem. OCR nie uruchamia się automatycznie; można go później uruchomić ze zapisanych zdjęć. Bez uploadu. Odznacz, aby zakończyć na samym wyszukiwaniu.";textSize=16f})
        val details=TextView(context).apply{text=DETAILS;textSize=16f;visibility=View.GONE;tag="poc.desktop.consentDetails"}
        val disclosure=Button(context).apply{text="Szczegóły";textSize=16f;tag="poc.desktop.consentDisclosure";setOnClickListener{details.visibility=if(details.visibility==View.GONE)View.VISIBLE else View.GONE;text=if(details.visibility==View.VISIBLE)"Ukryj" else "Szczegóły"}}
        content.addView(disclosure);content.addView(details)
        body.addView(content,ViewGroup.LayoutParams(-1,-2));root.addView(body,LinearLayout.LayoutParams(-1,0,1f))
        // Footer is outside ScrollView. Full-width buttons also fit large text.
        val footer=LinearLayout(context).apply{orientation=LinearLayout.VERTICAL;setPadding(0,dp(8),0,0)}
        footer.addView(Button(context).apply{text="Zgadzam się";textSize=16f;minHeight=dp(48);tag="poc.desktop.consentAccept";setOnClickListener{if(!accepted){accepted=true;val automatic=autoPhotos.isChecked;dismiss();onAccept(automatic)}}},LinearLayout.LayoutParams(-1,-2))
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
        private const val SUMMARY="Jednorazowa zgoda: automatyczne otwarcie zatwierdzonej grupy, odczyt postów i odpowiedzi sieciowych oraz lokalne miniatury zdjęć oraz ograniczone kopie wycinków w RAM do lokalnego OCR. Może rozwinąć „Zobacz więcej” w treści maks. 20 potwierdzonych postów, aby uzupełnić dane.\n\nPrzewijanie ruszy samo po załadowaniu: do 30 s, ruchy DOM co 0,5 s, maks. 20 ID. Bez gestu palcem i wyboru trybu.\n\nOstatni poprawny wynik i zdjęcia pozostają zapisane lokalnie do ponownego otwarcia. Przycisk Kasuj bazę usuwa ten zapis. Pauza, logowanie/CAPTCHA, zmiana grupy lub wygaszenie kończą próbę. Bez uploadu i kolektora."
        private const val DETAILS="Zakres: jedna zatwierdzona grupa, nowe otwarcie w standardowym trybie komputerowym GeckoView. Maks. 60 s łącznie z ładowaniem; do 30 s i 60 prób przewinięcia DOM. Ruchy DOM co 500 ms zamiast 1000 ms; oczekiwanie na dane, miniatury lub bezpieczne wejście GeckoView może zmniejszyć liczbę ruchów. Limit 20 przechowywanych ID.\n\nOdczyt DOM, danych strony oraz odpowiedzi fetch/XHR/other: do 64 odpowiedzi, 2 MiB każda, 4 MiB łącznie. Nasłuch przed otwarciem. Bez odczytu Beacon, nagłówków, wysyłanych formularzy, danych logowania, cookies lub tokenów.\n\nLokalne miniatury: do 3 widocznych zdjęć na post. Ograniczone kopie wycinków do OCR: do 1024 px, maks. 20 obrazów i 24 MiB łącznie. Otwieranie postów i zapis zdjęć są objęte tą jednorazową zgodą tylko przy zaznaczonej opcji automatycznej. OCR wymaga osobnej nowej zgody w Ofertach. Chwilowy obraz widoku Gecko w RAM jest usuwany po wycięciu miniatur. Bez dodatkowego pobierania mediów i zapisu adresów zdjęć. Potwierdzone wycinki zapisują się w prywatnej bazie lokalnej. Oficjalne wejście kółka myszy może pomóc po zatrzymaniu DOM; jego limity i zabezpieczenia pozostają aktywne.\n\nRozwijanie treści: wyłącznie rozpoznany przycisk Zobacz więcej / Wyświetl więcej / See more, lub krótkie więcej / more / rozwiń z dowodem zwiniętej treści. Kontrolka musi być we własnej wiadomości albo mieć potwierdzone powiązanie z tą wiadomością i oznaczenie zwiniętej treści, w obrębie tego samego posta z potwierdzonym ID tej grupy, raz na ID, maks. 20. Bez przechodzenia do linków, reakcji, komentarzy i udostępniania. Nadal obowiązuje wspólny limit czasu.\n\nZnany komunikat o powiadomieniach można zamknąć jego przyciskiem Zamknij, bez włączania powiadomień. Inne okna zatrzymują próbę. Dokładne ID/permalinki; pola i kwalifikacja ofert są heurystyczne. Pełne treści tylko przejściowo w ograniczonym RAM.\n\nOstatni poprawny wynik, wybrane pola, dokładne linki, miniatury i wycinki OCR pozostają zaszyfrowane lokalnie po pauzie i ponownym uruchomieniu. Sugestie OCR pozostają osobno. Przycisk Kasuj bazę usuwa ten zapis. Nowy poprawny wynik zastępuje poprzedni; pusty lub błędny przebieg go nie usuwa. Bez uploadu, backendu i produkcyjnego kolektora. Stary limit skanu, historia testów offline, outbox i potwierdzenia bez zmian.\n\nLogowanie, CAPTCHA, CHECKPOINT, inna grupa, utrata kontekstu lub wygaszenie kończą próbę. Tryb komputerowy pozostaje do zamknięcia sesji. Każda próba wymaga nowej zgody; otwarcie lub anulowanie tego okna niczego nie uruchamia."
    }
}
