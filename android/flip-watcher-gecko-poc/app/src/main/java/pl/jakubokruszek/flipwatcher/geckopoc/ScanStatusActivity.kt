package pl.jakubokruszek.flipwatcher.geckopoc

import android.os.Bundle
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
    private var refresh:Job?=null
    override fun onCreate(savedInstanceState:Bundle?){
        super.onCreate(savedInstanceState)
        val dp=resources.displayMetrics.density
        val body=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;setPadding((16*dp).toInt(),(16*dp).toInt(),(16*dp).toInt(),(16*dp).toInt())}
        body.addView(TextView(this).apply{text="Postęp automatu";textSize=22f;setTypeface(null,android.graphics.Typeface.BOLD)})
        body.addView(TextView(this).apply{text="Podgląd odświeża się co 2 sekundy. Możesz pozostawić ten ekran otwarty podczas skanu."})
        status=TextView(this).apply{tag="scan.live.status";text="Odczytywanie stanu…";textSize=17f;setTextIsSelectable(true);setPadding(0,(16*dp).toInt(),0,(16*dp).toInt())};body.addView(status)
        body.addView(Button(this).apply{text="Wykryj moje grupy na Facebooku";setOnClickListener{startActivity(android.content.Intent(this@ScanStatusActivity,JoinedGroupsActivity::class.java))}})
        body.addView(Button(this).apply{text="Dodaj grupę / profil w Managerze";setOnClickListener{startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW,android.net.Uri.parse(WatcherLink.ORIGIN+"/facebook-watcher/groups")))}})
        body.addView(TextView(this).apply{text="Po dodaniu grupy lub profilu wróć i zleć nowy skan. Automat odczytuje włączone źródła z Managera.";textSize=13f})
        body.addView(Button(this).apply{text="Wróć do aplikacji";setOnClickListener{finish()}})
        body.addView(TextView(this).apply{text="Dziennik techniczny";textSize=18f})
        journal=TextView(this).apply{tag="scan.live.journal";setTextIsSelectable(true)};body.addView(journal)
        val scroll=ScrollView(this).apply{addView(body,ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT))}
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(scroll){view,insets->val bars=insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars());view.setPadding(bars.left,bars.top,bars.right,bars.bottom);androidx.core.view.WindowInsetsCompat.CONSUMED}
        setContentView(scroll)
    }
    override fun onResume(){super.onResume();refresh=lifecycleScope.launch{
        while(true){
            val value=withContext(Dispatchers.IO){runCatching{WatcherScanStatus.report(this@ScanStatusActivity) to WatcherOutbox(this@ScanStatusActivity).use{it.status()}}}
            value.onSuccess{(report,log)->if(status.text.toString()!=report)status.text=report;if(journal.text.toString()!=log)journal.text=log}.onFailure{status.text="Nie udało się odczytać stanu. Zapisane wyniki pozostają zachowane."}
            delay(2_000)
        }
    }}
    override fun onPause(){refresh?.cancel();refresh=null;super.onPause()}
}
