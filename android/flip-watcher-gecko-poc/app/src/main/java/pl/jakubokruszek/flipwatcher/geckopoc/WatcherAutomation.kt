package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import androidx.work.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.time.Instant
import java.time.ZoneId
import java.util.concurrent.TimeUnit

object WatcherAutomation {
    @Volatile var uiVisible=false
    val lock=Mutex()
    fun preferences(context:Context)=context.getSharedPreferences("watcher-automation-v1",Context.MODE_PRIVATE)
    fun enabled(context:Context)=preferences(context).getBoolean("enabled",false)
    private const val WINDOW_TAG="watcher-window-v2"
    fun schedule(context:Context)=AutomationPolicy.decode(preferences(context).getString("scan_minutes",null))
    fun saveSchedule(context:Context,minutes:List<Int>){
        val value=AutomationPolicy.encode(minutes)
        check(preferences(context).edit().putString("scan_minutes",value)
            .putLong("schedule_since",System.currentTimeMillis()).remove("completed_slot").commit())
        WorkManager.getInstance(context).cancelAllWorkByTag(WINDOW_TAG)
        if(enabled(context))scheduleNext(context)
    }
    fun scheduleNext(context:Context){
        if(!enabled(context))return
        val now=Instant.now();val at=AutomationPolicy.next(now,ZoneId.systemDefault(),schedule(context))
        val work=OneTimeWorkRequestBuilder<WatcherAutomationWorker>()
            .setInitialDelay((at.toEpochMilli()-now.toEpochMilli()).coerceAtLeast(0),TimeUnit.MILLISECONDS)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .addTag(WINDOW_TAG).build()
        WorkManager.getInstance(context).enqueueUniqueWork("watcher-window-"+at.toEpochMilli(),ExistingWorkPolicy.KEEP,work)
    }
    fun configure(context:Context,enabled:Boolean){
        check(preferences(context).edit().putBoolean("enabled",enabled).commit())
        val manager=WorkManager.getInstance(context)
        if(enabled){
            // Persistent calendar work plus a cheap watchdog to recover reboot/time-zone/network changes.
            val work=PeriodicWorkRequestBuilder<WatcherAutomationWorker>(15,TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
            manager.enqueueUniquePeriodicWork("watcher-calendar-v1",ExistingPeriodicWorkPolicy.KEEP,work)
            scheduleNext(context);retry(context)
        }else{
            manager.cancelUniqueWork("watcher-calendar-v1");manager.cancelUniqueWork("watcher-retry-v1")
            manager.cancelUniqueWork("watcher-background-kick-v2");manager.cancelAllWorkByTag(WINDOW_TAG)
        }
    }
    fun retry(context:Context){
        WorkManager.getInstance(context).enqueueUniqueWork("watcher-retry-v1",ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<WatcherAutomationWorker>().setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
    }
    /** Called after the UI is paused: an immediate foreground attempt can no longer be silently consumed. */
    fun onBackground(context:Context){
        if(!enabled(context))return
        WorkManager.getInstance(context).enqueueUniqueWork("watcher-background-kick-v2",ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<WatcherAutomationWorker>().setInitialDelay(2,TimeUnit.SECONDS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
    }
    fun requestScan(context:Context){
        check(enabled(context)){"AUTOMATION_DISABLED"}
        check(preferences(context).edit().putString("requested_scan",java.util.UUID.randomUUID().toString()).commit())
        retry(context)
    }
    fun errorCode(error:Exception):String = when(error.javaClass.simpleName){
        "ForegroundServiceStartNotAllowedException"->"ANDROID_FOREGROUND_START_DENIED"
        "SecurityException"->"ANDROID_PERMISSION_DENIED"
        "SocketTimeoutException"->"NETWORK_TIMEOUT"
        "UnknownHostException"->"NETWORK_UNAVAILABLE"
        else->error.message?.takeIf{it.matches(Regex("[A-Z0-9_]{1,60}"))}?:"AUTOMATION_ERROR"
    }

}

open class WatcherAutomationWorker(context:Context,parameters:WorkerParameters):CoroutineWorker(context,parameters) {
    internal open fun credentials(context:Context)=WatcherLink.load(context)
    internal open fun send(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item)=WatcherUpload.send(credentials,item)
    internal open fun groups(credentials:WatcherLink.Credentials)=WatcherLink.groups(credentials,verifyDevice=true)
    override suspend fun doWork():Result {
        // A duplicate calendar/kick must not spend its job budget waiting behind another scan.
        if(!WatcherAutomation.lock.tryLock())return Result.success()
        return try{runWork()}finally{WatcherAutomation.lock.unlock()}
    }
    private suspend fun runWork():Result {
        val context=applicationContext
        if(!BuildConfig.LIVE_UPLOAD_ENABLED||!WatcherAutomation.enabled(context))return Result.success()
        return withContext(Dispatchers.IO){
            WatcherOutbox(context).use { queue ->
                try {
                    // Ordinary WorkManager jobs need no background-started foreground service.
                    // Stay below the ten-minute job limit and resume from durable group receipts.
                    val deadline=android.os.SystemClock.elapsedRealtime()+8*60*1000L
                    fun remaining()=deadline-android.os.SystemClock.elapsedRealtime()
                    var budgetReached=false
                    withTimeout(9*60*1000L){
                        val credentials=credentials(context)?:error("PAIRING_REQUIRED")
                        val prefs=WatcherAutomation.preferences(context)
                        val window=AutomationPolicy.current(Instant.now(),ZoneId.systemDefault(),WatcherAutomation.schedule(context))
                        val requested=prefs.getString("requested_scan",null)
                        val slot=if(requested==null)window.key else "manual/"+requested
                        val scheduleDue=requested!=null||window.at.toEpochMilli()>=prefs.getLong("schedule_since",0)
                        val alreadyCompleted=requested==null&&prefs.getString("completed_slot",null)==slot
                        if(!scheduleDue&&!queue.hasDue(credentials.deviceId,System.currentTimeMillis()))return@withTimeout
                        if(alreadyCompleted&&!queue.hasDue(credentials.deviceId,System.currentTimeMillis()))return@withTimeout
                        suspend fun flush(){
                            repeat(220){
                                currentCoroutineContext().ensureActive()
                                if(!WatcherAutomation.enabled(context))return
                                if(remaining()<30_000){budgetReached=true;return}
                                val item=queue.next(credentials.deviceId,System.currentTimeMillis())?:return
                                try{val receipt=send(credentials,item);queue.acknowledge(item.id,receipt);queue.log("UPLOAD_ACK")}
                                catch(e:WatcherUpload.HttpFailure){
                                    queue.defer(item,e.status in 400..499&&e.status !in setOf(408,429))
                                    queue.log("UPLOAD_HTTP_"+e.status)
                                    if(e.status in setOf(401,403))throw e
                                }catch(e:CancellationException){throw e}
                                catch(_:Exception){queue.defer(item);queue.log("UPLOAD_RETRY");return}
                            }
                        }
                        flush()
                        // Uploads use frozen snapshots and do not own the browser: drain even with UI visible.
                        if(WatcherAutomation.uiVisible){queue.log("WAITING_FOR_BACKGROUND");return@withTimeout}
                        if(alreadyCompleted||!scheduleDue||budgetReached)return@withTimeout
                        val groups=groups(credentials)
                        // Resume after the last attempted source if a slow group exhausted the worker budget.
                        val cursor=groups.indexOfFirst{it.id==prefs.getString("last_attempted_source",null)}
                        val ordered=if(cursor<0)groups else groups.drop(cursor+1)+groups.take(cursor+1)
                        for(group in ordered){
                            currentCoroutineContext().ensureActive()
                            if(WatcherAutomation.uiVisible||!WatcherAutomation.enabled(context))break
                            if(queue.scanned(slot,group.id))continue
                            if(remaining()<120_000){budgetReached=true;break}
                            queue.log("GROUP_"+(WatcherGroups.configured.indexOfFirst{it.id==group.id}+1))
                            check(prefs.edit().putString("last_attempted_source",group.id).commit())
                            queue.log("SCAN_STARTED")
                            try {
                            val scanned=BackgroundWatcherScan(context).run(group){!WatcherAutomation.uiVisible&&WatcherAutomation.enabled(context)}
                            val offers=scanned.rows.filter{DesktopSummary.eligible(it)||DesktopPresentation.reviewable(it)}
                            val ids=offers.map{it.postId}.toSet()
                            val result=scanned.copy(rows=offers,photos=scanned.photos.filter{it.postId in ids})
                            if(result.rows.isNotEmpty()){
                                // The encrypted automation database is independent: manual archives remain byte-for-byte intact.
                                // Frozen independent encrypted copies survive later scans and process death.
                                queue.enqueue(credentials.deviceId,group,result)
                            }
                            queue.completeScan(slot,group.id)
                            if(requested!=null)queue.completeScan(window.key,group.id)
                            queue.log("SCAN_SAVED",result.rows.size)
                            flush()
                            }catch(e:CancellationException){throw e}
                            catch(e:Exception){
                                if(e is WatcherUpload.HttpFailure&&e.status in setOf(401,403))throw e
                                queue.log(WatcherAutomation.errorCode(e))
                                // A single unavailable group cannot starve every later source.
                                if(e.message in setOf("LOGIN_REQUIRED","CHECKPOINT","CAPTCHA"))break
                            }
                        }
                        if(!WatcherAutomation.uiVisible&&WatcherAutomation.enabled(context)){
                            if(groups.isEmpty())queue.log("NO_ACTIVE_GROUPS")
                            if(groups.all{queue.scanned(window.key,it.id)})check(prefs.edit().putString("completed_slot",window.key).commit())
                            if(!budgetReached&&requested!=null&&prefs.getString("requested_scan",null)==requested)
                                check(prefs.edit().remove("requested_scan").commit())
                        }
                    }
                    if(budgetReached){queue.log("BATCH_CONTINUE");Result.retry()}else Result.success()
                }catch(e:CancellationException){queue.log("INTERRUPTED");throw e}
                catch(e:Exception){queue.log(WatcherAutomation.errorCode(e));Result.retry()}
                finally{runCatching{WatcherAutomation.scheduleNext(context)}}
            }
        }
    }
}
