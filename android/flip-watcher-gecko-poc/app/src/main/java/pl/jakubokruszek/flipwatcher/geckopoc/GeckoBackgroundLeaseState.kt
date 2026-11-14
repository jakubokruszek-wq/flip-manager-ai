package pl.jakubokruszek.flipwatcher.geckopoc

/** Serialized pure state for the opt-in diagnostic. These callbacks are our
 * compensating calls only; GeckoRuntime owns its normal pause/resume calls.
 * A foreground transition invalidates existing owners, so an interrupted old
 * test cannot resume Gecko again on a later pause while waiting for cleanup. */
internal class GeckoBackgroundLeaseState(private val nativePause:()->Unit,private val nativeResume:()->Unit){
 private var created=false
 private var paused=false
 private var owners=0
 private var eligible=0
 private var generation=0L
 private var ownsResume=false
 private var resumes=0
 private var pauses=0
 private fun increment(n:Int)=(n+1).coerceAtMost(100_000_000)
 fun runtimeCreated(){if(!created){created=true;paused=false}}
 fun processPaused(){if(!created)return;paused=true;compensate()}
 /** Must precede GeckoRuntime's upward lifecycle observer and its native resume. */
 fun processResumed(){invalidate();paused=false}
 /** Activity.onStarted precedes ProcessLifecycleOwner.ON_RESUME, including its
  * delayed resume. Restore before GeckoRuntime can decrement the native count. */
 fun foregroundStarting(){invalidate()}
 private fun invalidate(){generation++;eligible=0;restore()}
 private fun compensate(){
  if(created&&paused&&eligible>0&&!ownsResume){nativeResume();ownsResume=true;resumes=increment(resumes)}
 }
 private fun restore(){if(ownsResume){nativePause();ownsResume=false;pauses=increment(pauses)}}
 /** Caller must have independently checked that every application window is stopped. */
 fun acquire():AutoCloseable {
  check(owners<1000){"GECKO_LEASE_OWNERS"}
  val mine=generation;owners++;eligible++
  try{compensate()}catch(error:Throwable){owners--;eligible--;throw error}
  var closed=false
  return AutoCloseable{
   if(!closed){closed=true;owners--;if(mine==generation)eligible--;if(eligible==0)restore()}
  }
 }
 fun snapshot():Map<String,Int> = mapOf(
  "ownedNativeResumeCount" to resumes,"ownedNativePauseCount" to pauses,
  "leaseRuntimeCreated" to if(created)1 else 0,"leaseRuntimePaused" to if(paused)1 else 0,
  "runtimeCreated" to if(created)1 else 0,"runtimePaused" to if(paused)1 else 0,
  "leaseOwners" to owners,"leaseEligibleOwners" to eligible,"leaseCompensating" to if(ownsResume)1 else 0)
}
