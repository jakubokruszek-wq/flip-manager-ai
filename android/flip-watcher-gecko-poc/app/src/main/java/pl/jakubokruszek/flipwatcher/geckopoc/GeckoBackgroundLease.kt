package pl.jakubokruszek.flipwatcher.geckopoc

import android.os.Looper
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import org.mozilla.gecko.GeckoThread

/** EXPERIMENTAL, explicit diagnostic arm only. This is NOT a supported public
 * GeckoView graphics keepalive API and must not be acquired by production scans.
 *
 * Pinned Gecko158 registers its ProcessLifecycleOwner observer during create().
 * LifecycleRegistry2.9.1 dispatches upward events in registration order and
 * downward events in reverse order. Installing ours BEFORE create therefore
 * observes a real native pause AFTER GeckoRuntime, and restores our compensating
 * resume BEFORE GeckoRuntime's next native resume. Activity.onStarted is an
 * earlier restore barrier, independent of the later process resume dispatch.
 * No lease => no extra native calls. Cold runtimes start unpaused and must NEVER
 * receive a compensating resume until a post-creation pause has been observed.
 */
internal object GeckoBackgroundLease {
 private var installed=false
 private val state=GeckoBackgroundLeaseState(nativePause={GeckoThread.onPause()},nativeResume={GeckoThread.onResume()})
 private fun main(){check(Looper.myLooper()==Looper.getMainLooper()){"GECKO_LEASE_THREAD"}}
 fun installBeforeRuntime(){
  main();if(installed)return
  installed=true
  ProcessLifecycleOwner.get().lifecycle.addObserver(object:DefaultLifecycleObserver{
   override fun onPause(owner:LifecycleOwner){state.processPaused()}
   override fun onResume(owner:LifecycleOwner){state.processResumed()}
  })
 }
 fun runtimeCreated(){main();check(installed){"GECKO_LEASE_NOT_INSTALLED"};state.runtimeCreated()}
 fun foregroundStarting(){main();state.foregroundStarting()}
 fun acquire():AutoCloseable {
  main();check(installed){"GECKO_LEASE_NOT_INSTALLED"}
  check(!RenderComparisonVisibility.hasStartedActivity){"GECKO_LEASE_FOREGROUND"}
  val token=state.acquire()
  return AutoCloseable{main();token.close()}
 }
 fun snapshot():Map<String,Int>{main();return state.snapshot()+mapOf("leaseInstalled" to if(installed)1 else 0)}
}
