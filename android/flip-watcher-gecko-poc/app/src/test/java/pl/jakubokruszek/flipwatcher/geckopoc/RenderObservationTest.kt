package pl.jakubokruszek.flipwatcher.geckopoc
import org.junit.Assert.*
import org.junit.Test
class RenderObservationTest {
 @Test fun countersAreBoundedNumericAndSnapshotsDoNotChange(){
  var clock=100L;val o=RenderObservation("GROUP"){clock}
  o.available();o.acquired();o.composite();o.paint();o.crash();o.kill();o.acquisitionFailed(99)
  clock=180;val first=o.snapshot()
  assertEquals(1,first["groupAcquiredFrames"]);assertEquals(80,first["groupLastFrameAgeMs"])
  assertEquals(4,first["groupAcquireErrorCode"]);assertTrue(first.values.all{it in 0..100_000_000})
  o.acquired();assertEquals(1,first["groupAcquiredFrames"]);assertEquals(2,o.snapshot()["groupAcquiredFrames"])
  clock=Long.MAX_VALUE;assertEquals(100_000_000,o.snapshot()["groupLastFrameAgeMs"])
 }
 @Test fun diagnosticsExpireAndCannotBeActivatedByDefaultOrBackwardClock(){
  assertFalse(RenderObservationPolicy.active(0,1))
  assertTrue(RenderObservationPolicy.active(100+RenderObservationPolicy.DURATION,100))
  assertFalse(RenderObservationPolicy.active(100,100));assertFalse(RenderObservationPolicy.active(99,100))
  assertFalse(RenderObservationPolicy.active(101+RenderObservationPolicy.DURATION,100))
 }
}
