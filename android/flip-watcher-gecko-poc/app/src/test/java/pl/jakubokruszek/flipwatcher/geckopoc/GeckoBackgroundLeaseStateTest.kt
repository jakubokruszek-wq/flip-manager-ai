package pl.jakubokruszek.flipwatcher.geckopoc

import org.junit.Assert.*
import org.junit.Test

class GeckoBackgroundLeaseStateTest {
 private class Engine {
  var count=0;private set
  private var runtimePaused=false
  val state=GeckoBackgroundLeaseState(nativePause={count++},nativeResume={count--;check(count>=0){"Native pause count underflow"}})
  fun created(){state.runtimeCreated()}
  fun pause(){check(!runtimePaused);runtimePaused=true;count++;state.processPaused();check(count>=0)}
  fun resume(){state.processResumed();if(runtimePaused){count--;runtimePaused=false};check(count>=0)}
  fun starting(){state.foregroundStarting()}
  fun balanced(){val s=state.snapshot();assertEquals(s["ownedNativeResumeCount"],s["ownedNativePauseCount"]);assertEquals(0,s["leaseCompensating"])}
 }
 @Test fun normalLifecycleWithoutLeaseMakesNoExtraNativeCalls(){
  val e=Engine();e.created();e.resume();repeat(4){e.pause();assertEquals(1,e.count);e.resume();assertEquals(0,e.count)}
  assertEquals(0,e.state.snapshot()["ownedNativeResumeCount"]);e.balanced()
 }
 @Test fun coldRuntimeAndLeaseBeforeCreationNeverReceiveUnmatchedResume(){
  val e=Engine();val lease=e.state.acquire();e.created();assertEquals(0,e.count);lease.close();lease.close();e.resume()
  assertEquals(0,e.count);assertEquals(0,e.state.snapshot()["leaseOwners"]);e.balanced()
 }
 @Test fun existingBackgroundPauseIsCompensatedOnceAndRestoredOnCleanup(){
  val e=Engine();e.created();e.resume();e.pause();val lease=e.state.acquire()
  assertEquals(0,e.count);assertEquals(1,e.state.snapshot()["ownedNativeResumeCount"])
  lease.close();assertEquals(1,e.count);e.balanced();e.resume();assertEquals(0,e.count)
 }
 @Test fun nestedOwnersShareOneResumeAndOnlyLastOwnerRestores(){
  val e=Engine();e.created();e.pause();val first=e.state.acquire();val second=e.state.acquire()
  assertEquals(0,e.count);assertEquals(1,e.state.snapshot()["ownedNativeResumeCount"])
  second.close();assertEquals(0,e.count);first.close();assertEquals(1,e.count);e.balanced()
 }
 @Test fun cancellationFinallyRestoresBackgroundPause(){
  val e=Engine();e.created();e.pause();val lease=e.state.acquire()
  try{throw java.util.concurrent.CancellationException()}catch(_:java.util.concurrent.CancellationException){}finally{lease.close()}
  assertEquals(1,e.count);assertEquals(0,e.state.snapshot()["leaseOwners"]);e.balanced()
 }
 @Test fun activityStartRestoresBeforeRuntimeResumeAndOldOwnerCannotRearm(){
  val e=Engine();e.created();e.pause();val lease=e.state.acquire()
  e.starting();assertEquals(1,e.count);e.resume();assertEquals(0,e.count)
  e.pause();assertEquals("An interrupted owner cannot compensate another lifecycle pause",1,e.count)
  lease.close();e.balanced();e.resume();assertEquals(0,e.count)
 }
 @Test fun resumeObserverFallbackRestoresBeforeRuntimeNativeResume(){
  val e=Engine();e.created();e.pause();val lease=e.state.acquire()
  e.resume();assertEquals(0,e.count);lease.close();e.balanced()
 }
 @Test fun oldCancelledOwnerDoesNotReleaseNewGenerationLease(){
  val e=Engine();e.created();e.pause();val old=e.state.acquire();e.starting();e.resume();e.pause()
  val fresh=e.state.acquire();assertEquals(0,e.count);old.close();assertEquals(0,e.count)
  fresh.close();assertEquals(1,e.count);assertEquals(0,e.state.snapshot()["leaseOwners"]);e.balanced()
 }
 @Test fun manyBackgroundWorkUiCyclesKeepNativeCountWithinZeroAndOne(){
  val e=Engine();e.created();e.resume()
  repeat(50){e.pause();val lease=e.state.acquire();assertEquals(0,e.count);e.starting();assertEquals(1,e.count);e.resume();assertEquals(0,e.count);lease.close();e.balanced()}
 }
}
