package pl.jakubokruszek.flipwatcher.geckopoc

import android.app.PictureInPictureParams
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Rational
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.*
import org.mozilla.geckoview.GeckoView
import java.util.UUID

/** A real, user-started visible PiP experiment. Never a hidden scanner or an offer writer. */
internal open class RenderPipComparisonActivity:ComponentActivity() {
 protected lateinit var pipView:GeckoView
  private set
 protected open val diagnosticFixtureTarget:String? get()=null
 protected open fun onMeasurementStarted(){}
 protected open suspend fun reportResult(run:String,group:WatcherGroup,result:RenderComparisonResult){
  RenderComparisonStore.record(this,run,group,8,result)
 }
 private val lifecycleEvidence=mutableMapOf<String,Int>()
 private val entered=CompletableDeferred<Unit>()
 private var enteredOnce=false
 private var completed=false
 private var phase:Job?=null
 override fun onCreate(savedInstanceState:Bundle?){
  super.onCreate(savedInstanceState)
  if(android.os.Build.VERSION.SDK_INT>=33)setRecentsScreenshotEnabled(false)
  window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  pipView=GeckoView(this)
  setContentView(pipView)
  val run=intent.getStringExtra(EXTRA_RUN)
  val group=runCatching{WatcherGroup(intent.getStringExtra(EXTRA_GROUP)?:error("GROUP"),intent.getStringExtra(EXTRA_NAME).orEmpty().take(200))}.getOrNull()
  if(run==null||runCatching{UUID.fromString(run).toString()==run}.getOrDefault(false).not()||group==null||group.type!="GROUP"){
   finishAndRemoveTask();return
  }
  phase=lifecycleScope.launch{
   var locked=false
   val setupStats=mutableMapOf("pipRequested" to 1,"pipStage" to 1)
   var result=RenderComparisonResult("COMPARE_PIP_INTERRUPTED",mapOf("pipRequested" to 1))
   try {
    withTimeout(120000){
     if(!packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)){
      result=RenderComparisonResult("COMPARE_PIP_UNSUPPORTED",mapOf("pipRequested" to 1));return@withTimeout
     }
     withTimeout(10000){while(!lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))delay(50)}
     // Let the explicit task launch/resume settle before asking Android for PiP.
     delay(300)
     setupStats["pipStage"]=2
     withTimeout(15000){while(!WatcherAutomation.lock.tryLock())delay(100);locked=true}
     check(!RenderComparisonForegroundService.anyActive()){"COMPARE_FGS_BASELINE_BUSY"}
     WatcherAutomation.uiVisible=true
     // Initialize the shared runtime while RESUMED, matching the user's preceding
     // visible controls. A cold runtime created only after PiP entry could miss
     // the lifecycle pause and give a misleadingly easier test condition.
     GeckoHost.collectorExtension(this@RenderPipComparisonActivity)
     setupStats["pipStage"]=3
     val accepted=runCatching{enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(Rational(16,9)).build())}.getOrDefault(false)
     if(!accepted){result=RenderComparisonResult("COMPARE_PIP_ENTER_DENIED",mapOf("pipRequested" to 1));return@withTimeout}
     setupStats["pipStage"]=4
     withTimeout(8000){entered.await()}
     setupStats["pipStage"]=5
     var width=0;var height=0;var stableSince=0L
     withTimeout(10000){
      while(true){
       setupStats.putAll(PipRenderVisibility.snapshot(this@RenderPipComparisonActivity,pipView))
       setupStats.putAll(lifecycleEvidence)
       val w=pipView.width;val h=pipView.height
       val valid=w in 128..2160&&h in 128..2160&&w.toLong()*h<=4000000&&
        RenderComparisonVisibility.startedActivityCount==1&&PipRenderVisibility.matches(this@RenderPipComparisonActivity,pipView,w,h)
       val now=SystemClock.elapsedRealtime()
       if(!valid){stableSince=0L}
       else if(w!=width||h!=height||stableSince==0L){width=w;height=h;stableSince=now}
       else if(now-stableSince>=1000)break
       delay(100)
      }
     }
     val epoch=RenderComparisonVisibility.foregroundEpoch
     fun alive()=!completed&&RenderComparisonVisibility.foregroundEpoch==epoch&&RenderComparisonVisibility.startedActivityCount==1&&
      PipRenderVisibility.matches(this@RenderPipComparisonActivity,pipView,width,height)
     check(alive()){"COMPARE_PIP_INTERRUPTED"}
     val focusedAtStart=if(pipView.hasWindowFocus())1 else 0
     setupStats["pipStage"]=6
     onMeasurementStarted()
     val observed=RenderComparisonProbe.run(this@RenderPipComparisonActivity,group,pipView,width,height,::alive,
      fixtureTarget=diagnosticFixtureTarget,pipActivity=this@RenderPipComparisonActivity)
     result=observed.copy(issue=if(alive())observed.issue else "COMPARE_PIP_INTERRUPTED",stats=observed.stats+mapOf("pipRequested" to 1,"pipEntered" to 1,
      "pipVisibleAtStart" to 1,"pipFocusedAtStart" to focusedAtStart,"pipWidth" to width,"pipHeight" to height,
      "pipVisibleAtEnd" to if(alive())1 else 0,"pipFocusedAtEnd" to if(pipView.hasWindowFocus())1 else 0))
    }
   }catch(e:TimeoutCancellationException){result=RenderComparisonResult("COMPARE_PIP_TIMEOUT",setupStats.toMap()+lifecycleEvidence.toMap()+mapOf("pipEntered" to if(enteredOnce)1 else 0))}
    catch(e:CancellationException){result=RenderComparisonResult("COMPARE_PIP_INTERRUPTED",setupStats.toMap()+lifecycleEvidence.toMap()+mapOf("pipEntered" to if(enteredOnce)1 else 0));throw e}
    catch(e:Exception){val issue=e.message?.takeIf{it.matches(Regex("[A-Z0-9_]{1,60}"))}?:"COMPARE_PIP_ERROR";result=RenderComparisonResult(issue,setupStats.toMap()+lifecycleEvidence.toMap()+mapOf("pipEntered" to if(enteredOnce)1 else 0))}
   finally {
    completed=true
    withContext(NonCancellable+Dispatchers.Main.immediate){
     try{withTimeoutOrNull(10000){reportResult(run,group,result)}}
     finally {
      if(locked)WatcherAutomation.lock.unlock()
      Handler(Looper.getMainLooper()).post{WatcherAutomation.uiVisible=RenderComparisonVisibility.hasStartedActivity}
      finishAndRemoveTask()
     }
    }
   }
  }
 }
 override fun onStart(){super.onStart();lifecycleEvidence["pipPlatformStarted"]=1}
 override fun onSaveInstanceState(outState:Bundle){
  lifecycleEvidence["pipSaveCount"]=(lifecycleEvidence["pipSaveCount"]?:0)+1
  lifecycleEvidence["pipLifecycleBeforeSave"]=lifecycle.currentState.ordinal
  super.onSaveInstanceState(outState)
  lifecycleEvidence["pipLifecycleAfterSave"]=lifecycle.currentState.ordinal
 }
 override fun onResume(){super.onResume();WatcherAutomation.uiVisible=true}
 override fun onPictureInPictureModeChanged(inPictureInPictureMode:Boolean,newConfig:Configuration){
  super.onPictureInPictureModeChanged(inPictureInPictureMode,newConfig)
  if(inPictureInPictureMode){enteredOnce=true;entered.complete(Unit);WatcherAutomation.uiVisible=true}
  else if(enteredOnce&&!completed)phase?.cancel(CancellationException("COMPARE_PIP_INTERRUPTED"))
 }
 override fun onStop(){
  lifecycleEvidence["pipPlatformStarted"]=0
  super.onStop()
  if(!completed)phase?.cancel(CancellationException("COMPARE_PIP_INTERRUPTED"))
  Handler(Looper.getMainLooper()).post{WatcherAutomation.uiVisible=RenderComparisonVisibility.hasStartedActivity}
 }
 companion object {
  const val EXTRA_RUN="pipComparisonRun"
  const val EXTRA_GROUP="pipComparisonGroup"
  const val EXTRA_NAME="pipComparisonName"
  fun intent(context:Context,run:String,group:WatcherGroup):Intent {
   require(UUID.fromString(run).toString()==run&&group.type=="GROUP")
   return Intent(context,RenderPipComparisonActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    .putExtra(EXTRA_RUN,run).putExtra(EXTRA_GROUP,group.id).putExtra(EXTRA_NAME,group.name.take(200))
  }
 }
}
