package pl.jakubokruszek.flipwatcher.geckopoc

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.UUID

/** Explicit diagnostic priority factor only: no browser, scan, wake lock or offer writes. */
class RenderComparisonForegroundService:Service() {
 private var owned:Entry?=null
 private val handler=Handler(Looper.getMainLooper())
 private var expiry:Runnable?=null
 override fun onBind(intent:Intent?):IBinder?=null
 override fun onStartCommand(intent:Intent?,flags:Int,startId:Int):Int {
  val candidate=current
  if(candidate==null || candidate.token!=intent?.getStringExtra(EXTRA_TOKEN)){
   // A delayed obsolete intent must never terminate a newer owner's service.
   if(candidate==null && owned==null)stopSelf(startId)
   return START_NOT_STICKY
  }
  if(owned===candidate && candidate.active)return START_NOT_STICKY
  if(owned!=null || !RenderComparisonVisibility.hasStartedActivity){
   revoke(candidate);if(owned==null)stopSelf(startId);return START_NOT_STICKY
  }
  owned=candidate;candidate.service=this
  try {
   val manager=getSystemService(NotificationManager::class.java)
   if(manager.getNotificationChannel(CHANNEL)==null)manager.createNotificationChannel(NotificationChannel(CHANNEL,"Test obrazu w tle",NotificationManager.IMPORTANCE_LOW))
   val open=PendingIntent.getActivity(this,NOTIFICATION,Intent(this,ScanStatusActivity::class.java),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
   val notification=Notification.Builder(this,CHANNEL).setSmallIcon(android.R.drawable.ic_menu_search)
    .setContentTitle("Flip Watcher: test obrazu w tle")
    .setContentText("Trwa krótki pomiar diagnostyczny. Oferty nie są dodawane.")
    .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_SERVICE).build()
   if(Build.VERSION.SDK_INT>=Build.VERSION_CODES.Q)startForeground(NOTIFICATION,notification,ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
   else startForeground(NOTIFICATION,notification)
   candidate.active=true
   expiry=Runnable{finish(candidate)}.also{handler.postDelayed(it,MAX_RUN_MS)}
   candidate.ready.complete(true)
  }catch(_:Exception){finish(candidate)}
  return START_NOT_STICKY
 }
 private fun finish(entry:Entry){
  if(owned!==entry)return
  expiry?.let(handler::removeCallbacks);expiry=null
  retiring=this
  revoke(entry);owned=null
  stopForeground(STOP_FOREGROUND_REMOVE);stopSelf()
 }
 override fun onTimeout(startId:Int,fgsType:Int){owned?.let(::finish)?:stopSelf()}
 override fun onTimeout(startId:Int){owned?.let(::finish)?:stopSelf()}
 override fun onDestroy(){
  expiry?.let(handler::removeCallbacks);expiry=null
  owned?.let(::revoke);owned=null
  stopForeground(STOP_FOREGROUND_REMOVE)
  if(retiring===this)retiring=null
  super.onDestroy()
 }
 private class Entry(val run:String,val arm:Int){
  val token=UUID.randomUUID().toString()
  val ready=CompletableDeferred<Boolean>()
  @Volatile var active=false
  var service:RenderComparisonForegroundService?=null
 }
 companion object {
  private const val CHANNEL="watcher_render_comparison"
  private const val NOTIFICATION=48113
  private const val EXTRA_TOKEN="comparisonForegroundToken"
  private const val MAX_RUN_MS=120000L
  @Volatile private var current:Entry?=null
  @Volatile private var retiring:RenderComparisonForegroundService?=null
  private fun valid(run:String,arm:Int)=arm in 5..6 && runCatching{UUID.fromString(run).toString()==run}.getOrDefault(false)
  private fun revoke(entry:Entry){
   entry.active=false;entry.service=null;entry.ready.complete(false)
   if(current===entry)current=null
  }
  /** The Activity remains visible until this returns a confirmed foreground acknowledgment. */
  suspend fun start(context:Context,run:String,arm:Int):Boolean {
   var attempted:Entry?=null
   var transferred=false
   try {
    val accepted=withContext(Dispatchers.Main.immediate){
     if(!valid(run,arm)||!RenderComparisonVisibility.hasStartedActivity||current!=null)return@withContext false
     // stopSelf is asynchronous: never give the retiring instance a new owner.
     val retired=withTimeoutOrNull(1000){while(retiring!=null)delay(20);true}==true
     if(!retired||!RenderComparisonVisibility.hasStartedActivity||current!=null)return@withContext false
     val entry=Entry(run,arm);attempted=entry;current=entry
     var acknowledged=false
     try {
      context.applicationContext.startForegroundService(Intent(context,RenderComparisonForegroundService::class.java).putExtra(EXTRA_TOKEN,entry.token))
      acknowledged=withTimeoutOrNull(5000){entry.ready.await()}==true && current===entry && entry.active
      acknowledged
     }catch(e:kotlinx.coroutines.CancellationException){throw e}
      catch(_:Exception){false}
     finally {if(!acknowledged && current===entry)stop(context,run,arm)}
    }
    // This assignment occurs after withContext's cancellable return to its caller.
    transferred=accepted
    return accepted
   }finally {
    if(!transferred)withContext(NonCancellable+Dispatchers.Main.immediate){
     attempted?.let{if(current===it)stop(context,it.run,it.arm)}
    }
   }
  }
  fun isActive(run:String,arm:Int):Boolean=current?.let{it.run==run&&it.arm==arm&&it.active}==true
  /** Pending startup also blocks a baseline arm, avoiding a priority-factor race. */
  fun anyActive():Boolean=current!=null||retiring!=null
  /** Main-thread, identity-matched cleanup; stale trials cannot stop a newer owner. */
  fun stop(context:Context,run:String,arm:Int){
   check(Looper.myLooper()==Looper.getMainLooper())
   val entry=current?.takeIf{it.run==run&&it.arm==arm}?:return
   val service=entry.service
   if(service!=null)service.finish(entry)
   else {revoke(entry);context.applicationContext.stopService(Intent(context,RenderComparisonForegroundService::class.java))}
  }
 }
}
