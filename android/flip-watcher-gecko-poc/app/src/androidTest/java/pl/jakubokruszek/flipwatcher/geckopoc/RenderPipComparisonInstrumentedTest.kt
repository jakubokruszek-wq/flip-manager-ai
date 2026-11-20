package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import android.content.pm.PackageManager
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class RenderPipComparisonInstrumentedTest {
 private val context:Context=ApplicationProvider.getApplicationContext()
 private fun outboxFingerprint():List<String> = listOf("watcher-outbox-v1.db","watcher-outbox-v1.db-wal").map{name->
  val file=context.getDatabasePath(name)
  if(!file.exists())"absent"else java.security.MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString(""){"%02x".format(it)}
 }
 private suspend fun trial(action:suspend(ActivityScenario<RenderPipTestActivity>,RenderPipTestActivity.Awaited)->Unit):RenderComparisonResult {
  assumeTrue("Device declares no PiP capability",context.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE))
  val path="/groups/$FIXTURE_GROUP_ID/";val run=UUID.randomUUID().toString()
  val server=LoopbackFixtureServer(pages=mapOf(path to "desktop-green-sale-posters")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
  val awaited=RenderPipTestActivity.Awaited();val before=outboxFingerprint()
  RenderPipTestActivity.fixtureTarget="http://127.0.0.1:${server.port}$path"
  RenderPipTestActivity.pending[run]=awaited
  try {
   val intent=RenderPipComparisonActivity.intent(context,run,WatcherGroup(FIXTURE_GROUP_ID,"fixture")).setClass(context,RenderPipTestActivity::class.java)
   val result=ActivityScenario.launch<RenderPipTestActivity>(intent).use{scenario->
    action(scenario,awaited)
    withTimeout(115000){awaited.result.await()}
   }
   withTimeout(5000){while(!WatcherAutomation.lock.tryLock())delay(50);WatcherAutomation.lock.unlock()}
   assertEquals("PiP diagnostic must not create or modify offer outbox",before,outboxFingerprint())
   assertFalse(RenderComparisonForegroundService.anyActive())
   return result
  }finally{
   RenderPipTestActivity.pending.remove(run);RenderPipTestActivity.fixtureTarget=null;server.close()
  }
 }
 @Test fun actualVisiblePipHasSettledViewportAnimationAndOwnCapture()=runBlocking {
  val result=trial{_,_->}
  assertEquals("stats=${result.stats}","RENDER_COMPARE_OBSERVED",result.issue)
  assertEquals(1,result.stats["pipEntered"])
  assertEquals(1,result.stats["pipVisibleAtStart"]);assertEquals(1,result.stats["pipVisibleAtEnd"])
  assertTrue((result.stats["pipWidth"]?:0)>=PipRenderVisibility.MIN_VIEWPORT);assertTrue((result.stats["pipHeight"]?:0)>=PipRenderVisibility.MIN_VIEWPORT)
  assertEquals(result.stats["pipWidth"],result.stats["comparisonWidth"])
  assertEquals(result.stats["pipHeight"],result.stats["comparisonHeight"])
  assertEquals(result.stats["pipWidth"],result.stats["pipCaptureWidth"])
  assertEquals(result.stats["pipHeight"],result.stats["pipCaptureHeight"])
  assertEquals(1,result.stats["comparisonDocument"])
  assertEquals(1,result.stats["comparisonCapture"]);assertEquals(1,result.stats["comparisonVaried"])
  assertTrue((result.stats["timingRafCount5"]?:0)>0)
  assertTrue((result.stats["timingTimerCount5"]?:0)>0)
  assertFalse(result.stats.containsKey("frameSignalRequested"))
 }
 @Test fun closingPipMidMeasurementCancelsAndReleasesScannerLock()=runBlocking {
  val result=trial{scenario,awaited->
   withTimeout(20000){awaited.started.await()}
   scenario.onActivity{assertTrue(it.isInPictureInPictureMode);it.finish()}
  }
  assertEquals("COMPARE_PIP_INTERRUPTED",result.issue)
  assertEquals(1,result.stats["pipEntered"])
  assertNotEquals(1,result.stats["comparisonCapture"])
 }
 @Test fun resizingPipViewportCannotPassWithThePreviousDimensions()=runBlocking {
  val result=trial{scenario,awaited->
   withTimeout(20000){awaited.started.await()}
   scenario.onActivity{assertTrue(it.isInPictureInPictureMode);it.resizeViewportForTest()}
  }
  assertEquals("COMPARE_PIP_INTERRUPTED",result.issue)
  assertNotEquals(1,result.stats["comparisonCapture"])
 }
}
