package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Local paired FGS factors; validates ownership and cleanup, not physical-phone repair. */
@RunWith(AndroidJUnit4::class)
class ForegroundRenderComparisonInstrumentedTest {
 private val context:Context=ApplicationProvider.getApplicationContext()
 @Test fun foregroundAloneAndForegroundWithBalancedLeaseUseSameFixtureAndReleaseOwnership()=runBlocking {
  val path="/groups/$FIXTURE_GROUP_ID/"
  val server=LoopbackFixtureServer(pages=mapOf(path to "desktop-green-sale-posters")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
  val run=UUID.randomUUID().toString()
  try{ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->
   withContext(Dispatchers.Main){GeckoHost.collectorExtension(context)}
   for(arm in 5..6){
    scenario.moveToState(Lifecycle.State.RESUMED)
    withTimeout(5000){while(RenderComparisonForegroundService.anyActive())delay(50)}
    assertTrue(RenderComparisonForegroundService.start(context,run,arm))
    var lease:AutoCloseable?=null
    try{
     scenario.moveToState(Lifecycle.State.CREATED)
     withTimeout(10000){while(withContext(Dispatchers.Main){RenderComparisonVisibility.hasStartedActivity||GeckoBackgroundLease.snapshot()["leaseRuntimePaused"]!=1})delay(50)}
     if(arm==6)withContext(NonCancellable+Dispatchers.Main){lease=GeckoBackgroundLease.acquire()}
     val result=RenderComparisonProbe.run(context,WatcherGroup(FIXTURE_GROUP_ID,"fixture"),null,1080,1920,
      {!RenderComparisonVisibility.hasStartedActivity&&RenderComparisonForegroundService.isActive(run,arm)},"http://127.0.0.1:${server.port}$path")
     assertEquals("arm=$arm stats=${result.stats}","RENDER_COMPARE_OBSERVED",result.issue)
     assertEquals(1,result.stats["comparisonDocument"])
     assertEquals(1,result.stats["timingReply5"])
     assertEquals(1,result.stats["comparisonCapture"])
     assertTrue(RenderComparisonForegroundService.isActive(run,arm))
    }finally{withContext(NonCancellable+Dispatchers.Main){lease?.close();RenderComparisonForegroundService.stop(context,run,arm)}}
    assertEquals(0,withContext(Dispatchers.Main){GeckoBackgroundLease.snapshot()["leaseOwners"]})
   }
  }}finally{
   withContext(NonCancellable+Dispatchers.Main){for(arm in 5..6)RenderComparisonForegroundService.stop(context,run,arm)}
   server.close()
  }
 }
}
