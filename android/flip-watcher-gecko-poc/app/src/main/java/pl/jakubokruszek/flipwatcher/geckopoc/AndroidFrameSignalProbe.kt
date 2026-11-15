package pl.jakubokruszek.flipwatcher.geckopoc

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Choreographer

/** Instrumented public UI-signal demand only; never touches Gecko or a rendering surface. */
internal class AndroidFrameSignalProbe:AutoCloseable {
 private val handler:Handler
 private var choreographer:Choreographer?=null
 private var open=true
 private var activated=false
 private var frames=0
 private var timers=0
 private var lastFrame:Long?=null
 private var closedAt:Long?=null
 private fun main(){check(Looper.myLooper()==Looper.getMainLooper()){"FRAME_SIGNAL_MAIN_THREAD"}}
 private fun bounded(value:Long)=value.coerceIn(0,100_000_000).toInt()
 private val timer=object:Runnable {
  override fun run(){
   main();if(!open)return
   timers=bounded(timers.toLong()+1)
   handler.postDelayed(this,1000)
  }
 }
 private val frame=object:Choreographer.FrameCallback {
  override fun doFrame(frameTimeNanos:Long){
   main();if(!open||!activated)return
   frames=bounded(frames.toLong()+1);lastFrame=SystemClock.elapsedRealtime()
   choreographer?.postFrameCallback(this)
  }
 }
 init {
  main()
  handler=Handler(Looper.getMainLooper())
  handler.postDelayed(timer,1000)
 }
 /** Starting this independent callback requests Android frame events: it is an intervention. */
 fun activateFrames():Boolean {
  main();if(!open||activated)return false
  val source=runCatching{Choreographer.getInstance()}.getOrNull()?:return false
  // Publish only after posting succeeds; subsequent activation cannot add another chain.
  if(runCatching{source.postFrameCallback(frame)}.isFailure){runCatching{source.removeFrameCallback(frame)};return false}
  choreographer=source;activated=true
  return true
 }
 fun snapshot():Map<String,Int> {
  main()
  val last=lastFrame
  return mapOf("uiFrames" to frames,"uiTimers" to timers,"uiHasFrame" to if(last==null)0 else 1,
   "uiFrameAgeMs" to if(last==null)0 else bounded((closedAt?:SystemClock.elapsedRealtime())-last))
 }
 override fun close(){
  main();if(!open)return
  open=false;closedAt=SystemClock.elapsedRealtime()
  handler.removeCallbacks(timer)
  choreographer?.removeFrameCallback(frame)
 }
}
