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
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.Job
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
            WatcherScanStatus.quiet(context)
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
        WatcherScanStatus.request(context)
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
    internal open suspend fun scan(group:WatcherGroup,progress:(String)->Unit)=BackgroundWatcherScan(applicationContext).run(group,{!WatcherAutomation.uiVisible&&WatcherAutomation.enabled(applicationContext)},progress)
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
                val run=id.toString();var begun=false;var ticker:Job?=null
                fun begin(){if(!begun){WatcherScanStatus.begin(context,run);begun=true;ticker=launch{while(isActive){WatcherScanStatus.beat(context,run);delay(5_000)}}}}
                var budgetReached=false;var retryNeeded=false;var lastIssue=""
                try {
                    // Ordinary WorkManager jobs need no background-started foreground service.
                    // Stay below the ten-minute job limit and resume from durable group receipts.
                    val deadline=android.os.SystemClock.elapsedRealtime()+8*60*1000L
                    fun remaining()=deadline-android.os.SystemClock.elapsedRealtime()
                    withTimeout(9*60*1000L){
                        val credentials=credentials(context)?:error("PAIRING_REQUIRED")
                        val prefs=WatcherAutomation.preferences(context)
                        val window=AutomationPolicy.current(Instant.now(),ZoneId.systemDefault(),WatcherAutomation.schedule(context))
                        val requested=prefs.getString("requested_scan",null)
                        val slot=if(requested==null)window.key else "manual/"+requested
                        val scheduleDue=requested!=null||window.at.toEpochMilli()>=prefs.getLong("schedule_since",0)
                        val alreadyCompleted=requested==null&&prefs.getString("completed_slot",null)==slot
                        if(!scheduleDue&&!queue.hasDue(credentials.deviceId,System.currentTimeMillis())){WatcherScanStatus.checked(context,"WINDOW_NOT_DUE");return@withTimeout}
                        if(alreadyCompleted&&!queue.hasDue(credentials.deviceId,System.currentTimeMillis())){WatcherScanStatus.checked(context,"SLOT_COMPLETED");return@withTimeout}
                        begin()
                        suspend fun flush(){
                            repeat(220){
                                currentCoroutineContext().ensureActive()
                                if(!WatcherAutomation.enabled(context))return
                                if(remaining()<30_000){budgetReached=true;return}
                                val item=queue.next(credentials.deviceId,System.currentTimeMillis())?:return
                                val held=runCatching {
                                    val body=org.json.JSONObject(item.body);val group=body.getString("groupId")
                                    val row=SavedResultCodec.rows(org.json.JSONArray().put(body.getJSONObject("row")),group)?.singleOrNull()?:error("QUALITY_INVALID")
                                    OfferQuality.reason(row,body.getJSONArray("photos").length())
                                }.getOrElse{"QUALITY_INVALID"}
                                if(held!=null){queue.hold(item,held);return@repeat}
                                WatcherScanStatus.update(context,run){it.copy(phase="UPLOADING")}
                                try{val receipt=send(credentials,item);queue.acknowledge(item.id,receipt);queue.log("UPLOAD_ACK");WatcherScanStatus.update(context,run){it.copy(uploads=it.uploads+1)}}
                                catch(e:WatcherUpload.HttpFailure){
                                    queue.defer(item,e.status in 400..499&&e.status !in setOf(408,429))
                                    lastIssue="UPLOAD_HTTP_"+e.status;queue.log(lastIssue)
                                    if(e.status in setOf(401,403))throw e
                                }catch(e:CancellationException){throw e}
                                catch(_:Exception){queue.defer(item);lastIssue="UPLOAD_RETRY";queue.log(lastIssue);return}
                            }
                        }
                        flush()
                        // Uploads use frozen snapshots and do not own the browser: drain even with UI visible.
                        if(alreadyCompleted||!scheduleDue||budgetReached){WatcherScanStatus.finish(context,run,if(budgetReached)"RETRY"else"UPLOAD_DONE",if(budgetReached)"BATCH_CONTINUE"else lastIssue);return@withTimeout}
                        if(WatcherAutomation.uiVisible){queue.log("WAITING_FOR_BACKGROUND");WatcherScanStatus.finish(context,run,"WAITING_UI","WAITING_FOR_BACKGROUND");return@withTimeout}
                        val groups=groups(credentials)
                        // Resume after the last attempted source if a slow group exhausted the worker budget.
                        val cursor=groups.indexOfFirst{it.id==prefs.getString("last_attempted_source",null)}
                        val ordered=if(cursor<0)groups else groups.drop(cursor+1)+groups.take(cursor+1)
                        WatcherScanStatus.update(context,run){it.copy(total=groups.size,done=groups.count{g->queue.scanned(slot,g.id)})}
                        for((index,group) in ordered.withIndex()){
                            currentCoroutineContext().ensureActive()
                            if(WatcherAutomation.uiVisible||!WatcherAutomation.enabled(context))break
                            if(queue.scanned(slot,group.id))continue
                            if(remaining()<120_000){budgetReached=true;break}
                            queue.log("GROUP_"+(WatcherGroups.configured.indexOfFirst{it.id==group.id}+1))
                            check(prefs.edit().putString("last_attempted_source",group.id).commit())
                            queue.log("SCAN_STARTED")
                            val groupStartedAt=android.os.SystemClock.elapsedRealtime()
                            WatcherScanStatus.update(context,run){it.copy(phase="LOADING",group=group.name,position=index+1,reason="")}
                            try {
                            val scanned=scan(group){phase->WatcherScanStatus.update(context,run){it.copy(phase=phase)}}
                            WatcherScanStatus.update(context,run){it.copy(phase="SAVING")}
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
                            WatcherScanStatus.update(context,run){it.copy(done=groups.count{g->queue.scanned(slot,g.id)},posts=it.posts+result.rows.size,photos=it.photos+result.photos.size)}
                            flush()
                            }catch(e:CancellationException){throw e}
                            catch(e:Exception){
                                if(e is WatcherUpload.HttpFailure&&e.status in setOf(401,403))throw e
                                lastIssue=if(WatcherAutomation.uiVisible)"WAITING_FOR_BACKGROUND"else WatcherAutomation.errorCode(e)
                                queue.log(lastIssue)
                                WatcherScanStatus.update(context,run){it.copy(phase="PREPARING",reason=lastIssue)}
                                // A single unavailable group cannot starve every later source.
                                if(e.message in setOf("LOGIN_REQUIRED","CHECKPOINT","CAPTCHA"))break
                            }finally {
                                // Count-only timing, no post content or group names in diagnostics.
                                val seconds=((android.os.SystemClock.elapsedRealtime()-groupStartedAt)/1000L).coerceIn(0L,600L).toInt()
                                queue.log("GROUP_DURATION_SEC",seconds)
                            }
                        }
                        val allDone=groups.isNotEmpty()&&groups.all{queue.scanned(slot,it.id)}
                        if(!WatcherAutomation.uiVisible&&WatcherAutomation.enabled(context)){
                            if(groups.isEmpty()){lastIssue="NO_ACTIVE_GROUPS";queue.log(lastIssue)}
                            if(groups.isNotEmpty()&&groups.all{queue.scanned(window.key,it.id)})check(prefs.edit().putString("completed_slot",window.key).commit())
                            if(allDone&&requested!=null&&prefs.getString("requested_scan",null)==requested)
                                check(prefs.edit().remove("requested_scan").commit())
                        }
                        retryNeeded=!allDone&&!WatcherAutomation.uiVisible&&WatcherAutomation.enabled(context)&&groups.isNotEmpty()&&lastIssue !in setOf("LOGIN_REQUIRED","CHECKPOINT","CAPTCHA")
                        val reason=when{!WatcherAutomation.enabled(context)->"AUTOMATION_DISABLED";WatcherAutomation.uiVisible->"WAITING_FOR_BACKGROUND";budgetReached->"BATCH_CONTINUE";else->lastIssue}
                        val phase=when{!WatcherAutomation.enabled(context)->"ERROR";allDone->"DONE";WatcherAutomation.uiVisible->"WAITING_UI";budgetReached||retryNeeded->"RETRY";else->"PARTIAL"}
                        WatcherScanStatus.finish(context,run,phase,reason)
                    }
                    if(budgetReached||retryNeeded){if(budgetReached)queue.log("BATCH_CONTINUE");Result.retry()}else Result.success()
                }catch(e:CancellationException){queue.log("INTERRUPTED");if(begun)WatcherScanStatus.finish(context,run,"ERROR","INTERRUPTED");throw e}
                catch(e:Exception){val reason=if(e is WatcherUpload.HttpFailure)"UPLOAD_HTTP_"+e.status else WatcherAutomation.errorCode(e);queue.log(reason);begin();WatcherScanStatus.finish(context,run,"ERROR",reason);Result.retry()}
                finally{ticker?.cancel();runCatching{WatcherAutomation.scheduleNext(context)}}
            }
        }
    }
}
