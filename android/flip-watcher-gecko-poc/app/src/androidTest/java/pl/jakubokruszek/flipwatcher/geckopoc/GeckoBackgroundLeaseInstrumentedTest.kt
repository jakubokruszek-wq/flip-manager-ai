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

/** Pinned-engine integration: actual native compensation, cleanup and UI return.
 * All navigation is local; no device pairing, business queue or account is used. */
@RunWith(AndroidJUnit4::class)
class GeckoBackgroundLeaseInstrumentedTest {
 private val context:Context=ApplicationProvider.getApplicationContext()
 @Test fun ownedPauseIsRestoredOnBackgroundCleanupAndBeforeActualUiResume()=runBlocking {
  val path="/groups/$FIXTURE_GROUP_ID/"
  val server=LoopbackFixtureServer(pages=mapOf(path to "desktop-green-sale-posters")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
  suspend fun snapshot()=withContext(Dispatchers.Main){GeckoBackgroundLease.snapshot()}
  suspend fun waitForPause(){withTimeout(10_000){while(withContext(Dispatchers.Main){GeckoBackgroundLease.snapshot()["leaseRuntimePaused"]!=1||RenderComparisonVisibility.hasStartedActivity})delay(50)}}
  try{ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->
   withContext(Dispatchers.Main){withTimeout(30_000){GeckoHost.collectorExtension(context)}}
   scenario.moveToState(Lifecycle.State.CREATED);waitForPause()
   val before=snapshot();var lease:AutoCloseable?=null
   try{
    withContext(NonCancellable+Dispatchers.Main){lease=GeckoBackgroundLease.acquire()}
    val result=RenderComparisonProbe.run(context,WatcherGroup(FIXTURE_GROUP_ID,"fixture"),null,1080,1920,{!RenderComparisonVisibility.hasStartedActivity},"http://127.0.0.1:${server.port}$path")
    assertEquals("leased stats="+result.stats,"RENDER_COMPARE_OBSERVED",result.issue)
    assertEquals(1,result.stats["comparisonCapture"]);assertEquals(1,result.stats["comparisonDocument"])
    assertTrue((result.stats["groupRenderedFrames"]?:0)>0)
   }finally{withContext(NonCancellable+Dispatchers.Main){lease?.close();lease?.close()}}
   val closed=snapshot()
   assertEquals((before["ownedNativeResumeCount"]?:0)+1,closed["ownedNativeResumeCount"])
   assertEquals((before["ownedNativePauseCount"]?:0)+1,closed["ownedNativePauseCount"])
   assertEquals(0,closed["leaseOwners"]);assertEquals(0,closed["leaseCompensating"])
   assertEquals(1,closed["leaseRuntimePaused"])
   lease=null
   try{
    withContext(NonCancellable+Dispatchers.Main){lease=GeckoBackgroundLease.acquire()}
    val active=snapshot();assertEquals(1,active["leaseCompensating"])
    scenario.moveToState(Lifecycle.State.RESUMED)
    withTimeout(10_000){while(withContext(Dispatchers.Main){GeckoBackgroundLease.snapshot()["leaseRuntimePaused"]!=0})delay(50)}
    val resumed=snapshot()
    assertEquals(0,resumed["leaseCompensating"])
    assertEquals((closed["ownedNativePauseCount"]?:0)+1,resumed["ownedNativePauseCount"])
   }finally{withContext(NonCancellable+Dispatchers.Main){lease?.close()}}
   val final=snapshot()
   assertEquals(0,final["leaseOwners"]);assertEquals(final["ownedNativePauseCount"],final["ownedNativeResumeCount"])
   val normal=RenderComparisonProbe.run(context,WatcherGroup(FIXTURE_GROUP_ID,"fixture"),null,1080,1920,{RenderComparisonVisibility.hasStartedActivity},"http://127.0.0.1:${server.port}$path")
   assertEquals("normal stats="+normal.stats,"RENDER_COMPARE_OBSERVED",normal.issue)
   assertEquals(1,normal.stats["comparisonCapture"])
  }}finally{server.close()}
 }
}
