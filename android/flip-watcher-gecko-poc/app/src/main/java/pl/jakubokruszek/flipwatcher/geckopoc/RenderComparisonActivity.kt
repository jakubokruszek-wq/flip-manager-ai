package pl.jakubokruszek.flipwatcher.geckopoc

import android.os.Bundle
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.*
import org.mozilla.geckoview.GeckoView
import java.util.UUID

/** User-started diagnostic only; the ordinary scan and offer database are untouched. */
class RenderComparisonActivity:ComponentActivity() {
 private lateinit var status:TextView
 private lateinit var browser:GeckoView
 private lateinit var picker:Spinner
 private lateinit var start:Button
 private lateinit var background:Button
 private var groups:List<WatcherGroup> = emptyList()
 private var selected:WatcherGroup?=null
 private var run:String?=null
 private var width=0;private var height=0
 private var work:Job?=null;private var refresh:Job?=null;private var backgroundRequestedArm=0;private var readyForBackground=false
 override fun onCreate(savedInstanceState:Bundle?){
  super.onCreate(savedInstanceState)
  if(android.os.Build.VERSION.SDK_INT>=33)setRecentsScreenshotEnabled(false)
  window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  val body=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;setPadding(12,0,12,0)}
  body.addView(TextView(this).apply{text="Porównanie obrazu jednej grupy";textSize=20f})
  body.addView(TextView(this).apply{text="Najpierw widoczne okno, potem przechwytywanie bez okna i próba po schowaniu aplikacji. Każdy etap otwiera tę samą grupę. Każdy etap zawiera 25 sekund pomiaru animacji, timera i klatek. Zapisujemy tylko liczniki diagnostyczne. Nie dodajemy ofert ani zdjęć do Managera.";textSize=13f})
  picker=Spinner(this);body.addView(picker)
  start=Button(this).apply{text="Rozpocznij porównanie";tag="render.compare.start";isEnabled=false;setOnClickListener{begin()}};body.addView(start)
  background=Button(this).apply{text="Sprawdź po schowaniu aplikacji";tag="render.compare.background";isEnabled=false;setOnClickListener{
   if(run!=null&&selected!=null&&readyForBackground&&work?.isActive!=true){
    android.app.AlertDialog.Builder(this@RenderComparisonActivity).setTitle("Wybierz próbę w tle")
     .setItems(arrayOf("Zwykły test w tle","Próba naprawy pauzy Gecko","Test w tle z usługą pierwszego planu","Usługa pierwszego planu i korekta pauzy Gecko","Test sygnału odświeżania Androida")){_,which->
      beginBackground(which+3)
     }.setNegativeButton("Wróć",null).show()
   }
  }};body.addView(background)
  status=TextView(this).apply{tag="render.compare.status";textSize=13f;setTextIsSelectable(true);text=RenderComparisonStore.summary(this@RenderComparisonActivity)}
  body.addView(ScrollView(this).apply{addView(status)},LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,180))
  browser=GeckoView(this).apply{tag="render.compare.browser"}
  body.addView(browser,LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,0,1f))
  androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(body){view,insets->val bars=insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars());view.setPadding(bars.left,bars.top,bars.right,bars.bottom);androidx.core.view.WindowInsetsCompat.CONSUMED}
  setContentView(body)
  lifecycleScope.launch{
   val sources=withContext(Dispatchers.IO){runCatching{WatcherLink.load(this@RenderComparisonActivity)?.let{WatcherLink.sources(it,verifyDevice=true)}?.filter{it.type=="GROUP"}}}
   groups=sources.getOrNull().orEmpty()
   if(groups.isEmpty()){status.text="Nie udało się pobrać włączonych grup z Managera. Sprawdź połączenie Watchera.";return@launch}
   picker.adapter=ArrayAdapter(this@RenderComparisonActivity,android.R.layout.simple_spinner_dropdown_item,groups.map{it.name})
   val preferred=groups.indexOfFirst{it.id=="1424921570856189"};if(preferred>=0)picker.setSelection(preferred)
   start.isEnabled=true
  }
 }
 private fun beginBackground(arm:Int){
  val group=selected?:return;val key=run?:return
  background.isEnabled=false;start.isEnabled=false;picker.isEnabled=false
  lifecycleScope.launch{
   var handedOff=false
   try {
    if(RenderComparisonForegroundService.anyActive()){status.text="Poprzednia usługa diagnostyczna jeszcze trwa. Poczekaj na jej zakończenie.";return@launch}
    if(arm in 5..6){
     status.text="Uruchamiam usługę diagnostyczną z powiadomieniem…"
     if(!RenderComparisonForegroundService.start(this@RenderComparisonActivity,key,arm)){
      RenderComparisonStore.record(this@RenderComparisonActivity,key,group,arm,RenderComparisonResult("COMPARE_FGS_START_DENIED",mapOf("comparisonForegroundRequested" to 1)))
      status.text=RenderComparisonStore.summary(this@RenderComparisonActivity);return@launch
     }
    }
    if(!lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)||isFinishing){
     if(arm in 5..6)RenderComparisonForegroundService.stop(this@RenderComparisonActivity,key,arm)
     return@launch
    }
    backgroundRequestedArm=arm
    status.text="Aplikacja schowa się na czas próby. Poczekaj około 2 minut przed powrotem."
    handedOff=moveTaskToBack(true)
    if(!handedOff){
     backgroundRequestedArm=0
     if(arm in 5..6)RenderComparisonForegroundService.stop(this@RenderComparisonActivity,key,arm)
     status.text="Nie udało się schować aplikacji. Próba w tle nie została uruchomiona."
    }
   }finally{if(arm in 5..6 && !handedOff)RenderComparisonForegroundService.stop(this@RenderComparisonActivity,key,arm);background.isEnabled=true;start.isEnabled=true;picker.isEnabled=true}
  }
 }
 override fun onResume(){super.onResume();WatcherAutomation.uiVisible=true
  run?.let{key->for(arm in 5..6)RenderComparisonForegroundService.stop(this,key,arm)}
  if(readyForBackground&&work?.isActive!=true)background.isEnabled=true
  refresh=lifecycleScope.launch{while(true){if(work?.isActive!=true&&backgroundRequestedArm==0)status.text=RenderComparisonStore.summary(this@RenderComparisonActivity);delay(2000)}}
 }
 private fun begin(){
  if(work?.isActive==true)return
  if(RenderComparisonForegroundService.anyActive()){status.text="Poczekaj na zatrzymanie poprzedniej usługi diagnostycznej.";return}
  val group=groups.getOrNull(picker.selectedItemPosition)?:return
  if(browser.width !in 128..2160||browser.height !in 128..2160||browser.width.toLong()*browser.height>4_000_000){status.text="Okno przeglądarki jest za małe do porównania. Obróć telefon lub powiększ okno.";return}
  selected=group;run=UUID.randomUUID().toString();width=browser.width;height=browser.height
  RenderComparisonStore.begin(this,checkNotNull(run),group)
  readyForBackground=false;background.isEnabled=false;start.isEnabled=false;picker.isEnabled=false
  work=lifecycleScope.launch{
   var locked=false
   try {
    status.text="Czekam na zakończenie bieżącego odczytu…"
    withTimeout(15_000){while(!WatcherAutomation.lock.tryLock())delay(200);locked=true}
    fun alive()=lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)&&!isFinishing
    val key=checkNotNull(run)
    status.text="1 — widoczne okno. Nie opuszczaj tego ekranu."
    val visible=RenderComparisonProbe.run(this@RenderComparisonActivity,group,browser,width,height,::alive)
    RenderComparisonStore.record(this@RenderComparisonActivity,key,group,1,visible)
    if(visible.stats["comparisonDocument"]!=1){status.text=RenderComparisonStore.summary(this@RenderComparisonActivity);return@launch}
    status.text="2 — ten sam rozmiar obrazu bez widocznego okna. Aplikacja nadal jest na ekranie."
    val headless=RenderComparisonProbe.run(this@RenderComparisonActivity,group,null,width,height,::alive)
    RenderComparisonStore.record(this@RenderComparisonActivity,key,group,2,headless)
    status.text=RenderComparisonStore.summary(this@RenderComparisonActivity)
    readyForBackground=true;background.isEnabled=true
   }catch(_:TimeoutCancellationException){status.text="Czytnik jest zajęty. Spróbuj ponownie po zakończeniu bieżącej próby."}
    catch(_:CancellationException){status.text="Porównanie przerwane po opuszczeniu widocznego okna. Możesz rozpocząć je ponownie."}
    catch(_:Exception){status.text="Nie ukończono porównania. Zapisane wyniki diagnostyki pozostają dostępne."}
   finally{if(locked)WatcherAutomation.lock.unlock();start.isEnabled=true;picker.isEnabled=true}
  }
 }
 override fun onPause(){refresh?.cancel();refresh=null;work?.cancel();WatcherAutomation.uiVisible=false;super.onPause()}
 override fun onStop(){
  super.onStop()
  if(backgroundRequestedArm!=0){val arm=backgroundRequestedArm;backgroundRequestedArm=0
   val group=selected;val key=run
   if(group!=null&&key!=null)RenderComparisonWorker.enqueue(applicationContext,key,group,width,height,runtimeLease=arm==4||arm==6,foreground=arm in 5..6,frameSignal=arm==7)
  }
 }
}
