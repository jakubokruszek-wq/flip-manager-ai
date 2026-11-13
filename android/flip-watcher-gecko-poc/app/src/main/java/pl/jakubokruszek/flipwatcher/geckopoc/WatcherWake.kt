package pl.jakubokruszek.flipwatcher.geckopoc

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.work.ListenableWorker.Result
import androidx.work.WorkInfo
import kotlinx.coroutines.*
import java.util.UUID

/** User-granted exact calendar alarm; WorkManager remains a fallback, not the wake-up mechanism. */
internal object WatcherWake {
    private const val CALENDAR=91
    private const val RETRY=92
    const val AT="expected_at"
    internal var runFactory:(Context)->WatcherAutomationRun={WatcherAutomationRun(it,UUID.randomUUID())}
    /** Only invoked by a visible user action; no exact-alarm grant is needed. */
    fun startManual(c:Context){
        try{c.startForegroundService(Intent(c,WatcherAlarmService::class.java).putExtra("trigger","manual"))}
        catch(_:Exception){WatcherScanStatus.checked(c,"MANUAL_FGS_START_REFUSED");WatcherAutomation.retry(c)}
    }
    fun exact(context:Context)=Build.VERSION.SDK_INT<31||context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()
    private fun operation(c:Context,code:Int,at:Long)=PendingIntent.getBroadcast(c,code,Intent(c,WatcherAlarmReceiver::class.java).putExtra(AT,at),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    fun schedule(c:Context,at:Long,code:Int=CALENDAR):Boolean {
        if(!WatcherAutomation.enabled(c)||!exact(c))return false
        return try {
            c.getSystemService(AlarmManager::class.java).setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,at,operation(c,code,at))
            WatcherAutomation.preferences(c).edit().putLong(if(code==CALENDAR)"wake_alarm_at"else"wake_retry_at",at).apply()
            true
        }catch(_:SecurityException){false}
    }
    fun retry(c:Context){
        if(!WatcherAutomation.enabled(c))return
        val p=WatcherAutomation.preferences(c);val n=p.getInt("wake_retry_attempt",0)
        val delay=(10*60_000L*(1L shl n.coerceAtMost(3))).coerceAtMost(60*60_000L)
        p.edit().putInt("wake_retry_attempt",n+1).apply()
        val at=System.currentTimeMillis()+delay
        if(schedule(c,at,RETRY))p.edit().putLong("continuation_at",at).apply() else WatcherAutomation.retry(c)
    }
    fun cancel(c:Context){
        val alarms=c.getSystemService(AlarmManager::class.java)
        for(code in listOf(CALENDAR,RETRY))alarms.cancel(operation(c,code,0))
        WatcherAutomation.preferences(c).edit().remove("wake_alarm_at").remove("wake_retry_at").remove("wake_retry_attempt").apply()
    }
    fun description(c:Context):String = if(exact(c))"Dokładny alarm: włączony"else"Dokładny alarm: brak zgody „Alarmy i przypomnienia” — start może być odroczony"
}

class WatcherAlarmReceiver:BroadcastReceiver(){
    override fun onReceive(context:Context,intent:Intent){
        if(!WatcherAutomation.enabled(context))return
        val expected=intent.getLongExtra(WatcherWake.AT,0)
        if(expected<=0||System.currentTimeMillis()+1000<expected)return
        WatcherAutomation.preferences(context).edit().putLong("last_alarm_expected",expected).putLong("last_alarm_received",System.currentTimeMillis()).apply()
        try{context.startForegroundService(Intent(context,WatcherAlarmService::class.java))}
        catch(e:Exception){
            WatcherOutbox(context).use{it.log("ALARM_FGS_START_REFUSED")}
            WatcherScanStatus.checked(context,"ALARM_FGS_START_REFUSED")
            WatcherAutomation.retry(context)
        }
        runCatching{WatcherAutomation.scheduleNext(context)}
    }
}

/** Reschedule only: boot broadcasts never directly start a dataSync foreground service. */
class WatcherClockReceiver:BroadcastReceiver(){
    override fun onReceive(context:Context,intent:Intent){if(WatcherAutomation.enabled(context))WatcherAutomation.scheduleNext(context)}
}

class WatcherAlarmService:Service(){
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.IO)
    private var task:Job?=null
    @Volatile private var manualHandoff=false
    private var wake:PowerManager.WakeLock?=null
    private var stopped=WorkInfo.STOP_REASON_UNKNOWN
    override fun onBind(intent:Intent?):IBinder?=null
    override fun onStartCommand(intent:Intent?,flags:Int,startId:Int):Int {
        if(!WatcherAutomation.enabled(this)){stopSelf();return START_NOT_STICKY}
        val manager=getSystemService(NotificationManager::class.java)
        val channel="watcher_automatic_scan"
        manager.createNotificationChannel(NotificationChannel(channel,"Automatyczny skan",NotificationManager.IMPORTANCE_LOW))
        val open=PendingIntent.getActivity(this,93,Intent(this,ScanStatusActivity::class.java),PendingIntent.FLAG_IMMUTABLE)
        val notification=Notification.Builder(this,channel).setSmallIcon(android.R.drawable.ic_menu_search)
            .setContentTitle("Automatyczny skan · MetrON").setContentText("Skan działa przy wygaszonym ekranie. Dotknij, aby zobaczyć postęp.")
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).build()
        try{if(Build.VERSION.SDK_INT>=29)startForeground(93,notification,ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)else startForeground(93,notification)}
        catch(_:Exception){WatcherScanStatus.checked(this,"ALARM_FGS_START_REFUSED");WatcherAutomation.retry(this);stopSelf();return START_NOT_STICKY}
        if(task?.isActive==true){
            if(intent?.getStringExtra("trigger")=="manual")manualHandoff=true
            return START_NOT_STICKY
        }
        running=true
        val power=getSystemService(PowerManager::class.java)
        wake=power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"flipwatcher:automatic-scan").apply{setReferenceCounted(false);acquire(MAX_RUN_MS+30_000)}
        WatcherAutomation.preferences(this).edit().putLong("last_service_started",System.currentTimeMillis())
            .putBoolean("last_service_screen_on",power.isInteractive).putBoolean("last_service_idle",power.isDeviceIdleMode).putString("last_start_trigger",if(intent?.getStringExtra("trigger")=="manual")"manual_service"else"exact_alarm_service").apply()
        task=scope.launch {
            try {
                withTimeout(MAX_RUN_MS){
                    // A tap in PocActivity starts the service while foreground;
                    // its read-only progress screen is then opened. Wait for
                    // browser ownership to be released before collecting.
                    val uiUntil=android.os.SystemClock.elapsedRealtime()+30_000
                    while(WatcherAutomation.uiVisible&&WatcherAutomation.enabled(this@WatcherAlarmService)&&android.os.SystemClock.elapsedRealtime()<uiUntil)delay(100)
                    if(WatcherAutomation.uiVisible){WatcherScanStatus.checked(this@WatcherAlarmService,"WAITING_FOR_BACKGROUND");return@withTimeout}
                    do {
                        manualHandoff=false
                        var continuation=false
                        val base=WatcherWake.runFactory(this@WatcherAlarmService)
                        val run=object:WatcherAutomationRun(applicationContext,base.id){
                            override fun interruptionReason()=stopped
                            override fun recoverInterrupted(context:Context){WatcherWake.retry(context)}
                            override fun continueScan(context:Context){continuation=true}
                            override fun sourceTimeoutMs(remaining:Long)=base.sourceTimeoutMs(remaining)
                            override fun credentials(context:Context)=base.credentials(context)
                            override fun send(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item)=base.send(credentials,item)
                            override fun sendReport(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item)=base.sendReport(credentials,item)
                            override fun groups(credentials:WatcherLink.Credentials)=base.groups(credentials)
                            override suspend fun scan(group:WatcherGroup,progress:(String)->Unit)=base.scan(group,progress)
                        }
                        val result=run.run(waitForLock=true)
                        if(result==Result.retry()){WatcherWake.retry(this@WatcherAlarmService);break}
                        if((!continuation&&!manualHandoff)||!WatcherAutomation.enabled(this@WatcherAlarmService)||WatcherAutomation.uiVisible)break
                        delay(250)
                    }while(isActive)
                }
            }catch(_:TimeoutCancellationException){WatcherScanStatus.checked(this@WatcherAlarmService,"ALARM_SERVICE_BUDGET");WatcherWake.retry(this@WatcherAlarmService)}
            catch(e:CancellationException){throw e}
            catch(_:Exception){WatcherWake.retry(this@WatcherAlarmService)}
            finally{stopSelf()}
        }
        return START_NOT_STICKY
    }
    override fun onTimeout(startId:Int,fgsType:Int){stopped=WorkInfo.STOP_REASON_TIMEOUT;task?.cancel();stopSelf()}
    override fun onDestroy(){
        running=false
        if(!WatcherAutomation.enabled(this))stopped=WorkInfo.STOP_REASON_CANCELLED_BY_APP
        scope.cancel();wake?.let{if(it.isHeld)it.release()};super.onDestroy()
    }
    companion object{private const val MAX_RUN_MS=90*60_000L;@Volatile internal var running=false;private set}
}
