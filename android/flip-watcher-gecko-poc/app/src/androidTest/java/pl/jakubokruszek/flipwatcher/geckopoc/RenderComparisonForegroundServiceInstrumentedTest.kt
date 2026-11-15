package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class RenderComparisonForegroundServiceInstrumentedTest {
 private val context:Context=ApplicationProvider.getApplicationContext()
 private suspend fun stop(run:String,arm:Int){
  val wasOwner=RenderComparisonForegroundService.isActive(run,arm)
  withContext(Dispatchers.Main){RenderComparisonForegroundService.stop(context,run,arm)}
  // Retirement remains a baseline blocker until Android delivers onDestroy.
  if(wasOwner)withTimeout(5000){while(RenderComparisonForegroundService.anyActive())delay(20)}
 }
 @Test fun acknowledgedForegroundServiceSurvivesAllWindowsStoppedAndCleansUp()=runBlocking {
  val run=UUID.randomUUID().toString()
  try {
   ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->
    assertTrue(RenderComparisonVisibility.hasStartedActivity)
    assertTrue(RenderComparisonForegroundService.start(context,run,5))
    assertTrue("Only a successful startForeground can acknowledge active",RenderComparisonForegroundService.isActive(run,5))
    assertTrue(RenderComparisonForegroundService.anyActive())
    scenario.moveToState(Lifecycle.State.CREATED)
    withTimeout(5000){while(RenderComparisonVisibility.hasStartedActivity)delay(50)}
    delay(1500)
    assertFalse("Foreground service must not fabricate a visible Activity",RenderComparisonVisibility.hasStartedActivity)
    assertTrue(RenderComparisonForegroundService.isActive(run,5))
    stop(run,5)
    assertFalse(RenderComparisonForegroundService.isActive(run,5))
    assertFalse(RenderComparisonForegroundService.anyActive())
   }
  }finally{stop(run,5)}
 }
 @Test fun staleRunAndWrongArmCleanupCannotTerminateCurrentOwner()=runBlocking {
  val run=UUID.randomUUID().toString();val stale=UUID.randomUUID().toString()
  try {
   ActivityScenario.launch(GeckoTestHostActivity::class.java).use{
    assertTrue(RenderComparisonForegroundService.start(context,run,6))
    stop(stale,6);stop(run,5)
    assertTrue(RenderComparisonForegroundService.isActive(run,6))
    assertFalse(RenderComparisonForegroundService.start(context,stale,5))
    assertTrue(RenderComparisonForegroundService.isActive(run,6))
    stop(run,6);stop(run,6)
    assertFalse(RenderComparisonForegroundService.anyActive())
   }
  }finally{stop(run,6)}
 }
 @Test fun startupWithoutStartedActivityFailsClosed()=runBlocking {
  val run=UUID.randomUUID().toString()
  try {
   ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->
    scenario.moveToState(Lifecycle.State.CREATED)
    withTimeout(5000){while(RenderComparisonVisibility.hasStartedActivity)delay(50)}
    assertFalse(RenderComparisonForegroundService.start(context,run,5))
    assertFalse(RenderComparisonForegroundService.anyActive())
   }
  }finally{stop(run,5)}
 }
 @Test fun invalidInputNeverCreatesDiagnosticForegroundOwnership()=runBlocking {
  ActivityScenario.launch(GeckoTestHostActivity::class.java).use{
   for((run,arm)in listOf("bad" to 5,UUID.randomUUID().toString() to 3,UUID.randomUUID().toString() to 7)){
    assertFalse(RenderComparisonForegroundService.start(context,run,arm))
    assertFalse(RenderComparisonForegroundService.anyActive())
   }
  }
 }
 @Test fun immediateRestartWaitsForOldInstanceDestruction()=runBlocking {
  val first=UUID.randomUUID().toString();val second=UUID.randomUUID().toString()
  try {
   ActivityScenario.launch(GeckoTestHostActivity::class.java).use{
    assertTrue(RenderComparisonForegroundService.start(context,first,5))
    withContext(Dispatchers.Main){
     RenderComparisonForegroundService.stop(context,first,5)
     assertTrue("Pending teardown must still block baseline arms",RenderComparisonForegroundService.anyActive())
     assertTrue(RenderComparisonForegroundService.start(context,second,6))
    }
    delay(200)
    assertTrue("Old onDestroy cannot revoke replacement",RenderComparisonForegroundService.isActive(second,6))
   }
  }finally{stop(first,5);stop(second,6)}
 }
 @Test fun cancellationWhileReturningAcknowledgmentReleasesUntransferredOwnership()=runBlocking {
  val run=UUID.randomUUID().toString()
  val queue=java.util.concurrent.ConcurrentLinkedQueue<Runnable>()
  val dispatcher=object:CoroutineDispatcher(){override fun dispatch(context:kotlin.coroutines.CoroutineContext,block:Runnable){queue.add(block)}}
  val scope=CoroutineScope(SupervisorJob()+dispatcher)
  try {
   ActivityScenario.launch(GeckoTestHostActivity::class.java).use{
    var delivered=false
    val job=scope.launch{delivered=RenderComparisonForegroundService.start(context,run,5)}
    queue.remove().run()
    withTimeout(5000){while(!RenderComparisonForegroundService.isActive(run,5))delay(10)}
    // The Main block acknowledged startup, but the caller dispatcher has not run.
    withTimeout(5000){while(queue.isEmpty())delay(10)}
    job.cancel()
    withTimeout(5000){while(!job.isCompleted){while(true){val task=queue.poll()?:break;task.run()};delay(10)}}
    assertFalse(delivered)
    withTimeout(5000){while(RenderComparisonForegroundService.anyActive())delay(10)}
    assertFalse(RenderComparisonForegroundService.isActive(run,5))
   }
  }finally{scope.cancel();stop(run,5)}
 }

}
