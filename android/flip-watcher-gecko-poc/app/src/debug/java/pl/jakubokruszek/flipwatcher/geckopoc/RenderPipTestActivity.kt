package pl.jakubokruszek.flipwatcher.geckopoc

import kotlinx.coroutines.CompletableDeferred
import java.util.concurrent.ConcurrentHashMap

/** Debug-only fixture hook: no intent parameter can enable loopback mode in the release Activity. */
internal class RenderPipTestActivity:RenderPipComparisonActivity() {
 protected override val diagnosticFixtureTarget:String get()=checkNotNull(fixtureTarget)
 protected override fun onMeasurementStarted(){pending[intent.getStringExtra(EXTRA_RUN)]?.started?.complete(Unit)}
 protected override suspend fun reportResult(run:String,group:WatcherGroup,result:RenderComparisonResult){pending[run]?.result?.complete(result)}
 fun resizeViewportForTest(){
  pipView.layoutParams=pipView.layoutParams.apply{width=(pipView.width-32).coerceAtLeast(1)}
  pipView.requestLayout()
 }
 companion object {
  class Awaited {
   val started=CompletableDeferred<Unit>()
   val result=CompletableDeferred<RenderComparisonResult>()
  }
  @Volatile var fixtureTarget:String?=null
  val pending=ConcurrentHashMap<String,Awaited>()
 }
}
