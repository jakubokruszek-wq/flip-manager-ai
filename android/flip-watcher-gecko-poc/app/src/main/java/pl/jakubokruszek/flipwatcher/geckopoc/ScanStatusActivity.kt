package pl.jakubokruszek.flipwatcher.geckopoc

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Read-only screen: no browser/session ownership and no uiVisible flag, so scanning continues. */
class ScanStatusActivity:ComponentActivity(){
    private lateinit var status:TextView
    private lateinit var journal:TextView
    private lateinit var sources:TextView
    private var sourcesExpanded=false
    private var journalExpanded=false
    private var refresh:Job?=null
    override fun onCreate(savedInstanceState:Bundle?){
        super.onCreate(savedInstanceState)
        sourcesExpanded=savedInstanceState?.getBoolean("sourcesExpanded")?:false
        journalExpanded=savedInstanceState?.getBoolean("journalExpanded")?:false
        val dp=resources.displayMetrics.density
        val body=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;setPadding((16*dp).toInt(),(16*dp).toInt(),(16*dp).toInt(),(16*dp).toInt())}
        body.addView(TextView(this).apply{text="Postęp automatu";textSize=22f;setTypeface(null,android.graphics.Typeface.BOLD)})
        body.addView(TextView(this).apply{text="Podgląd odświeża się co 2 sekundy. Możesz pozostawić ten ekran otwarty podczas skanu."})
        body.addView(Button(this).apply{tag="scan.resume";text="Wznów tę samą próbę teraz";setOnClickListener{
            runCatching{WatcherAutomation.resume(this@ScanStatusActivity)}
                .onSuccess{android.widget.Toast.makeText(this@ScanStatusActivity,"Zlecono wznowienie z zachowaniem postępu.",android.widget.Toast.LENGTH_SHORT).show()}
                .onFailure{error->android.widget.Toast.makeText(this@ScanStatusActivity,if(error.message=="SCAN_ALREADY_FINISHED")"Ta próba jest zakończona. Nowy odczyt uruchom przez Skan teraz w tle."else"Nie zlecono wznowienia. Sprawdź, czy automat jest włączony.",android.widget.Toast.LENGTH_LONG).show()}
        }})
        status=TextView(this).apply{tag="scan.live.status";text="Odczytywanie stanu…";textSize=17f;setTextIsSelectable(true);setPadding(0,(16*dp).toInt(),0,(16*dp).toInt())};body.addView(status)
        sources=TextView(this).apply{tag="scan.live.sources";setTextIsSelectable(true);visibility=if(sourcesExpanded)View.VISIBLE else View.GONE}
        body.addView(Button(this).apply{tag="scan.sources.toggle";text=if(sourcesExpanded)"Ukryj grupy i profile"else"Pokaż grupy i profile";setOnClickListener{
            sourcesExpanded=!sourcesExpanded
            text=if(sourcesExpanded)"Ukryj grupy i profile"else"Pokaż grupy i profile"
            sources.visibility=if(sourcesExpanded)View.VISIBLE else View.GONE
            sources.text=if(sourcesExpanded)"Odczytywanie źródeł…"else""
        }})
        body.addView(sources)
        journal=TextView(this).apply{tag="scan.live.journal";setTextIsSelectable(true);visibility=if(journalExpanded)View.VISIBLE else View.GONE}
        body.addView(Button(this).apply{tag="scan.journal.toggle";text=if(journalExpanded)"Ukryj dziennik techniczny"else"Pokaż dziennik techniczny";setOnClickListener{
            journalExpanded=!journalExpanded
            text=if(journalExpanded)"Ukryj dziennik techniczny"else"Pokaż dziennik techniczny"
            journal.visibility=if(journalExpanded)View.VISIBLE else View.GONE
            journal.text=if(journalExpanded)"Odczytywanie dziennika…"else""
        }})
        body.addView(journal)
        body.addView(Button(this).apply{text="Wykryj moje grupy na Facebooku";setOnClickListener{startActivity(android.content.Intent(this@ScanStatusActivity,JoinedGroupsActivity::class.java))}})
        body.addView(Button(this).apply{text="Dodaj grupę / profil w Managerze";setOnClickListener{startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW,android.net.Uri.parse(WatcherLink.ORIGIN+"/facebook-watcher/groups")))}})
        body.addView(TextView(this).apply{text="Po dodaniu grupy lub profilu wróć i zleć nowy skan. Automat odczytuje włączone źródła z Managera.";textSize=13f})
        body.addView(Button(this).apply{text="Wróć do aplikacji";setOnClickListener{finish()}})
        val scroll=ScrollView(this).apply{addView(body,ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT))}
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(scroll){view,insets->val bars=insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars());view.setPadding(bars.left,bars.top,bars.right,bars.bottom);androidx.core.view.WindowInsetsCompat.CONSUMED}
        setContentView(scroll)
    }
    override fun onResume(){super.onResume();refresh=lifecycleScope.launch{
        while(true){
            val showSources=sourcesExpanded;val showJournal=journalExpanded
            val value=withContext(Dispatchers.IO){runCatching{Triple(WatcherScanStatus.report(this@ScanStatusActivity),if(showSources)WatcherScanStatus.sourceReport(this@ScanStatusActivity)else null,if(showJournal)WatcherOutbox(this@ScanStatusActivity).use{it.status()}else null)}}
            value.onSuccess{(report,details,log)->
                if(status.text.toString()!=report)status.text=report
                if(sourcesExpanded&&details!=null&&sources.text.toString()!=details)sources.text=details
                if(journalExpanded&&log!=null&&journal.text.toString()!=log)journal.text=log
            }.onFailure{status.text="Nie udało się odczytać stanu. Zapisane wyniki pozostają zachowane."}
            delay(2_000)
        }
    }}
    override fun onSaveInstanceState(outState:Bundle){outState.putBoolean("sourcesExpanded",sourcesExpanded);outState.putBoolean("journalExpanded",journalExpanded);super.onSaveInstanceState(outState)}
    override fun onPause(){refresh?.cancel();refresh=null;super.onPause()}
}
