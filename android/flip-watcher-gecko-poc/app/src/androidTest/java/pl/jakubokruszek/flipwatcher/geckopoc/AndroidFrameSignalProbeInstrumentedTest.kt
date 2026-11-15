package pl.jakubokruszek.flipwatcher.geckopoc

import android.view.Choreographer
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidFrameSignalProbeInstrumentedTest {
 @Test fun timersAdvanceBeforeFrameActivationAndCloseStopsBothSignals()=runBlocking {
  ActivityScenario.launch(GeckoTestHostActivity::class.java).use{
   val probe=withContext(Dispatchers.Main){AndroidFrameSignalProbe()}
   try {
    withTimeout(5000){while(withContext(Dispatchers.Main){probe.snapshot().getValue("uiTimers")}<1)delay(50)}
    val before=withContext(Dispatchers.Main){probe.snapshot()}
    assertEquals(0,before["uiFrames"]);assertEquals(0,before["uiHasFrame"]);assertEquals(0,before["uiFrameAgeMs"])
    assertTrue(withContext(Dispatchers.Main){probe.activateFrames()})
    assertFalse(withContext(Dispatchers.Main){probe.activateFrames()})
    withTimeout(5000){while(withContext(Dispatchers.Main){probe.snapshot().getValue("uiFrames")}<3)delay(20)}
    val frozen=withContext(Dispatchers.Main){probe.close();probe.close();assertFalse(probe.activateFrames());probe.snapshot()}
    assertEquals(1,frozen["uiHasFrame"])
    delay(1100)
    assertEquals("Closed probe must not leave timer or frame chains",frozen,withContext(Dispatchers.Main){probe.snapshot()})
   }finally{withContext(Dispatchers.Main){probe.close()}}
  }
 }
 @Test fun repeatedActivationNeverCreatesDuplicateCallbacksWithinOneAndroidFrame()=runBlocking {
  ActivityScenario.launch(GeckoTestHostActivity::class.java).use{
   val probe=withContext(Dispatchers.Main){AndroidFrameSignalProbe()}
   val samples=java.util.concurrent.CopyOnWriteArrayList<Pair<Long,Int>>()
   val done=kotlinx.coroutines.CompletableDeferred<Unit>()
   var observer:Choreographer.FrameCallback?=null
   var source:Choreographer?=null
   try {
    withContext(Dispatchers.Main){
     source=Choreographer.getInstance()
     assertTrue(probe.activateFrames())
     repeat(20){assertFalse(probe.activateFrames())}
     observer=object:Choreographer.FrameCallback {
      override fun doFrame(time:Long){
       samples.add(time to probe.snapshot().getValue("uiFrames"))
       if(samples.size>=8)done.complete(Unit)else source!!.postFrameCallback(this)
      }
     }
     source!!.postFrameCallback(observer!!)
    }
    withTimeout(5000){done.await()}
    assertTrue(samples.first().second>0)
    assertEquals("Exactly one probe callback between successive public frame callbacks",List(samples.size-1){1},samples.zipWithNext{a,b->b.second-a.second})
    assertTrue(samples.zipWithNext{a,b->b.first>a.first}.all{it})
   }finally{withContext(Dispatchers.Main){observer?.let{source?.removeFrameCallback(it)};probe.close()}}
  }
 }
 @Test fun closeBeforeActivationLeavesNoFrameDemandAndOffMainCallsFail()=runBlocking {
  val probe=withContext(Dispatchers.Main){AndroidFrameSignalProbe()}
  try {
   withContext(Dispatchers.Main){probe.close();assertFalse(probe.activateFrames())}
   delay(1100)
   assertEquals(mapOf("uiFrames" to 0,"uiTimers" to 0,"uiHasFrame" to 0,"uiFrameAgeMs" to 0),withContext(Dispatchers.Main){probe.snapshot()})
   for(operation in listOf<()->Unit>({AndroidFrameSignalProbe();Unit},{probe.activateFrames();Unit},{probe.snapshot();Unit},{probe.close()})){
    val error=withContext(Dispatchers.Default){runCatching(operation).exceptionOrNull()}
    assertTrue(error is IllegalStateException)
    assertEquals("FRAME_SIGNAL_MAIN_THREAD",error?.message)
   }
  }finally{withContext(Dispatchers.Main){probe.close()}}
 }
}
