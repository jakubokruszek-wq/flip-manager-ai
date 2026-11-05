package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** One explicit read of the phone's existing Facebook session; no membership changes. */
class JoinedGroupsActivity:ComponentActivity(){
    private lateinit var status:TextView
    private lateinit var start:Button
    private var task:Job?=null
    private var clock:Job?=null
    private var phase=""
    override fun onCreate(state:Bundle?){
        super.onCreate(state)
        val body=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;val p=(16*resources.displayMetrics.density).toInt();setPadding(p,p,p,p)}
        body.addView(TextView(this).apply{text="Wykryj moje grupy";textSize=22f})
        body.addView(TextView(this).apply{text="Odczyt z Twojej zalogowanej sesji Facebooka. Manager doda nowe łódzkie grupy nieruchomościowe i pominie już zapisane. Pozostałe wyniki pokaże do przejrzenia. Nigdzie nie dołączamy do grup ani nie publikujemy postów."})
        status=TextView(this).apply{tag="discovery.status";textSize=17f;text="Gotowe do wykrywania.";setTextIsSelectable(true)};body.addView(status)
        start=Button(this).apply{text="Ponów wykrywanie";setOnClickListener{begin()}};body.addView(start)
        body.addView(Button(this).apply{text="Wróć";setOnClickListener{finish()}})
        val scroll=ScrollView(this).apply{addView(body)}
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(scroll){view,insets->val bars=insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars());view.setPadding(bars.left,bars.top,bars.right,bars.bottom);androidx.core.view.WindowInsetsCompat.CONSUMED}
        setContentView(scroll)
        start.post{if(!isFinishing)begin()}
    }
    private fun begin(){
        if(task?.isActive==true)return
        start.isEnabled=false
        val began=android.os.SystemClock.elapsedRealtime()
        phase="Czekam na zakończenie bieżącego skanu…"
        clock=lifecycleScope.launch{while(isActive){status.text="$phase\nCzas: ${(android.os.SystemClock.elapsedRealtime()-began)/1000} s";delay(1000)}}
        task=lifecycleScope.launch{
            try{
                val credentials=withContext(Dispatchers.IO){WatcherLink.load(this@JoinedGroupsActivity)}?:error("WATCHER_PAIRING_REQUIRED")
                val value=WatcherAutomation.lock.withLock{JoinedGroupsScan(this@JoinedGroupsActivity).run({isActive}){phase=it}}
                if(value.groups.isEmpty())error("DISCOVERY_NO_GROUP_LINKS")
                phase="Znaleziono ${value.groups.size} grup. Przekazuję do Managera…"
                val handoff=withContext(Dispatchers.IO){WatcherDiscoveryUpload.send(credentials,value)}
                clock?.cancel()
                status.text="Przekazano ${value.groups.size} grup, w tym ${value.groups.count{it.name!=null}} z odczytaną nazwą. Manager sprawdzi nowe źródła. Odczyt obejmuje listę załadowaną przez Facebooka."
                startActivity(Intent(Intent.ACTION_VIEW,Uri.parse(handoff)))
            }catch(e:CancellationException){throw e}
            catch(e:Exception){
                clock?.cancel()
                status.text=when(e.message){
                    "LOGIN_REQUIRED","CHECKPOINT","CAPTCHA"->"Facebook wymaga ręcznego zalogowania lub weryfikacji w aplikacji. Po jej zakończeniu uruchom wykrywanie ponownie."
                    "WATCHER_PAIRING_REQUIRED"->"Najpierw połącz aplikację z Managerem w narzędziach Watchera."
                    "DISCOVERY_NO_GROUP_LINKS"->"Facebook nie pokazał odczytywalnej listy Twoich grup. Nie dodano żadnych źródeł. Zapisane grupy pozostają zachowane."
                    "DISCOVERY_MODAL_BLOCKED"->"Okno Facebooka zasłania listę grup. Dokończ je ręcznie w sesji Facebooka i ponów wykrywanie."
                    else->"Nie udało się zakończyć wykrywania (${WatcherAutomation.errorCode(e)}). Zapisane grupy pozostają zachowane."
                }
            }finally{clock?.cancel();start.isEnabled=true}
        }
    }
    override fun onDestroy(){task?.cancel();clock?.cancel();super.onDestroy()}
}
