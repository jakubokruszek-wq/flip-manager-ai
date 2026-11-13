package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import androidx.work.*
import androidx.work.ListenableWorker.Result
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.TimeoutCancellationException
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
    internal const val CONTINUATION_TAG="watcher-continuation-v1"
    internal const val CONTINUATION_DELAY_MS=30_000L
    internal const val RECOVERY_WORK="watcher-interruption-recovery-v1"
    internal fun recoverInterrupted(context:Context,enqueue:(String,ExistingWorkPolicy,OneTimeWorkRequest)->Unit={name,policy,work->WorkManager.getInstance(context).enqueueUniqueWork(name,policy,work);Unit}){
        if(!enabled(context))return
        // Independent from the interrupted continuation's dependency chain. KEEP
        // coalesces repeated stops; WorkManager may also reschedule the original.
        val work=OneTimeWorkRequestBuilder<WatcherAutomationWorker>()
            .setInitialDelay(CONTINUATION_DELAY_MS,TimeUnit.MILLISECONDS)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .addTag(CONTINUATION_TAG).build()
        enqueue(RECOVERY_WORK,ExistingWorkPolicy.KEEP,work)
        check(preferences(context).edit().putLong("continuation_at",System.currentTimeMillis()+CONTINUATION_DELAY_MS).commit())
    }
    internal fun continuation(context:Context,enqueue:(String,ExistingWorkPolicy,OneTimeWorkRequest)->Unit={name,policy,work->WorkManager.getInstance(context).enqueueUniqueWork(name,policy,work);Unit}){
        if(!enabled(context))return
        val work=OneTimeWorkRequestBuilder<WatcherAutomationWorker>()
            .setInitialDelay(CONTINUATION_DELAY_MS,TimeUnit.MILLISECONDS)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .addTag(CONTINUATION_TAG).build()
        enqueue(CONTINUATION_TAG,ExistingWorkPolicy.APPEND_OR_REPLACE,work)
        check(preferences(context).edit().putLong("continuation_at",System.currentTimeMillis()+CONTINUATION_DELAY_MS).commit())
    }
    internal fun resume(context:Context,enqueue:(OneTimeWorkRequest)->Unit={WatcherWake.startManual(context);Unit}){
        check(enabled(context)){"AUTOMATION_DISABLED"}
        val state=WatcherScanStatus.read(context)
        check(!(state.phase in setOf("DONE","PARTIAL")&&state.total>0&&state.done>=state.total)){"SCAN_ALREADY_FINISHED"}
        // Preserve the pending manual cycle and every durable source receipt.
        enqueue(OneTimeWorkRequestBuilder<WatcherAutomationWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .addTag(CONTINUATION_TAG).build())
        preferences(context).edit().remove("continuation_at").apply()
        WatcherScanStatus.resume(context)
    }
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
        WatcherWake.schedule(context,at.toEpochMilli())
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
            WatcherWake.cancel(context)
            context.stopService(android.content.Intent(context,WatcherAlarmService::class.java))
            WatcherScanStatus.quiet(context)
            manager.cancelUniqueWork("watcher-calendar-v1");manager.cancelUniqueWork("watcher-retry-v1")
            manager.cancelUniqueWork("watcher-background-kick-v2");manager.cancelAllWorkByTag(WINDOW_TAG)
            manager.cancelUniqueWork(CONTINUATION_TAG);manager.cancelAllWorkByTag(CONTINUATION_TAG)
            manager.cancelUniqueWork(RECOVERY_WORK)
            preferences(context).edit().remove("continuation_at").apply()
        }
    }
    fun retry(context:Context){
        WorkManager.getInstance(context).enqueueUniqueWork("watcher-retry-v1",ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<WatcherAutomationWorker>().setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
    }
    /** Called after the UI is paused: an immediate foreground attempt can no longer be silently consumed. */
    fun onBackground(context:Context){
        if(!enabled(context))return
        WorkManager.getInstance(context).enqueueUniqueWork("watcher-background-kick-v2",ExistingWorkPolicy.APPEND_OR_REPLACE,
            OneTimeWorkRequestBuilder<WatcherAutomationWorker>().setInitialDelay(2,TimeUnit.SECONDS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
    }
    fun requestScan(context:Context){
        check(enabled(context)){"AUTOMATION_DISABLED"}
        check(preferences(context).edit().putString("requested_scan",java.util.UUID.randomUUID().toString()).commit())
        WatcherScanStatus.request(context)
        WatcherWake.startManual(context)
    }
    fun errorCode(error:Exception):String = when(error.javaClass.simpleName){
        "TimeoutCancellationException"->"SOURCE_TIMEOUT"
        "ForegroundServiceStartNotAllowedException"->"ANDROID_FOREGROUND_START_DENIED"
        "SecurityException"->"ANDROID_PERMISSION_DENIED"
        "SocketTimeoutException"->"NETWORK_TIMEOUT"
        "UnknownHostException"->"NETWORK_UNAVAILABLE"
        else->error.message?.takeIf{it.matches(Regex("[A-Z0-9_]{1,60}"))}?:"AUTOMATION_ERROR"
    }

}

open class WatcherAutomationWorker(context:Context,parameters:WorkerParameters):CoroutineWorker(context,parameters) {
    internal open fun interruptionReason()=stopReason
    internal open fun recoverInterrupted(context:Context)=WatcherAutomation.recoverInterrupted(context)
    internal open fun continueScan(context:Context)=WatcherAutomation.continuation(context)
    internal open fun sourceTimeoutMs(remaining:Long)=minOf(175_000L,(remaining-30_000L).coerceAtLeast(1L))
    internal open fun credentials(context:Context)=WatcherLink.load(context)
    internal open fun send(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item)=WatcherUpload.send(credentials,item)
    internal open fun sendReport(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item)=WatcherUpload.report(credentials,item)
    internal open fun groups(credentials:WatcherLink.Credentials)=WatcherLink.sources(credentials,verifyDevice=true)
    internal open suspend fun scan(group:WatcherGroup,progress:(String)->Unit)=if(group.type=="PROFILE")ProfileWatcherScan(applicationContext).run(group,{!WatcherAutomation.uiVisible&&WatcherAutomation.enabled(applicationContext)},progress)else BackgroundWatcherScan(applicationContext).run(group,{!WatcherAutomation.uiVisible&&WatcherAutomation.enabled(applicationContext)},progress)
    override suspend fun doWork():Result = object:WatcherAutomationRun(applicationContext,id){
        override fun interruptionReason()=this@WatcherAutomationWorker.interruptionReason()
        override fun recoverInterrupted(context:Context)=this@WatcherAutomationWorker.recoverInterrupted(context)
        override fun continueScan(context:Context)=this@WatcherAutomationWorker.continueScan(context)
        override fun sourceTimeoutMs(remaining:Long)=this@WatcherAutomationWorker.sourceTimeoutMs(remaining)
        override fun credentials(context:Context)=this@WatcherAutomationWorker.credentials(context)
        override fun send(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item)=this@WatcherAutomationWorker.send(credentials,item)
        override fun sendReport(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item)=this@WatcherAutomationWorker.sendReport(credentials,item)
        override fun groups(credentials:WatcherLink.Credentials)=this@WatcherAutomationWorker.groups(credentials)
        override suspend fun scan(group:WatcherGroup,progress:(String)->Unit)=this@WatcherAutomationWorker.scan(group,progress)
    }.run()
}

internal open class WatcherAutomationRun(val applicationContext:Context,val id:java.util.UUID) {
    internal open fun interruptionReason()=WorkInfo.STOP_REASON_UNKNOWN
    internal open fun recoverInterrupted(context:Context)=WatcherAutomation.recoverInterrupted(context)
    internal open fun continueScan(context:Context)=WatcherAutomation.continuation(context)
    internal open fun sourceTimeoutMs(remaining:Long)=minOf(175_000L,(remaining-30_000L).coerceAtLeast(1L))
    internal open fun credentials(context:Context)=WatcherLink.load(context)
    internal open fun send(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item)=WatcherUpload.send(credentials,item)
    internal open fun sendReport(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item)=WatcherUpload.report(credentials,item)
    internal open fun groups(credentials:WatcherLink.Credentials)=WatcherLink.sources(credentials,verifyDevice=true)
    internal open suspend fun scan(group:WatcherGroup,progress:(String)->Unit)=if(group.type=="PROFILE")ProfileWatcherScan(applicationContext).run(group,{!WatcherAutomation.uiVisible&&WatcherAutomation.enabled(applicationContext)},progress)else BackgroundWatcherScan(applicationContext).run(group,{!WatcherAutomation.uiVisible&&WatcherAutomation.enabled(applicationContext)},progress)
    suspend fun run(waitForLock:Boolean=false):Result {
        // A duplicate calendar/kick must not spend its job budget waiting behind another scan.
        if(waitForLock)WatcherAutomation.lock.lock() else if(!WatcherAutomation.lock.tryLock())return Result.success()
        return try{runWork()}finally{WatcherAutomation.lock.unlock()}
    }
    private suspend fun runWork():Result {
        val context=applicationContext
        if(!BuildConfig.LIVE_UPLOAD_ENABLED||!WatcherAutomation.enabled(context))return Result.success()
        return withContext(Dispatchers.IO){
            WatcherOutbox(context).use { queue ->
                val run=id.toString();var begun=false;var ticker:Job?=null
                fun begin(){if(!begun){WatcherAutomation.preferences(context).edit().remove("continuation_at").apply();WatcherScanStatus.begin(context,run);begun=true;ticker=launch{var ticks=0;while(isActive){WatcherScanStatus.beat(context,run,++ticks%3==0);delay(5_000)}}}}
                var budgetReached=false;var retryNeeded=false;var networkPaused=false;var rendererPaused=false;var renderFailures=0;var lastIssue=""
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
                        val windowKey=WatcherCaptureReport.cycle(window.key)
                        val slot=if(requested==null)windowKey else WatcherCaptureReport.cycle("manual/"+requested)
                        check(prefs.edit().putString("capture_cycle",slot).commit())
                        val scheduleDue=requested!=null||window.at.toEpochMilli()>=prefs.getLong("schedule_since",0)
                        val reopened=queue.reopenNetworkFailures(slot)
                        val windowReopened=if(slot==windowKey)reopened else queue.reopenNetworkFailures(windowKey)
                        if(windowReopened>0&&prefs.getString("completed_slot",null)==windowKey)
                            check(prefs.edit().remove("completed_slot").putBoolean("completed_capture_ok",false).commit())
                        // Diagnostics retry independently and never prevent business queue delivery.
                        for(attempt in 0 until 3){val diagnostic=queue.nextReport(credentials.deviceId)?:break
                            try{sendReport(credentials,diagnostic);queue.reportSent(diagnostic.id)}catch(_:Exception){break}}
                        val alreadyCompleted=requested==null&&prefs.getString("completed_slot",null)==slot
                        if(!scheduleDue&&!queue.hasDue(credentials.deviceId,System.currentTimeMillis())){WatcherScanStatus.checked(context,"WINDOW_NOT_DUE");return@withTimeout}
                        if(alreadyCompleted&&!queue.hasDue(credentials.deviceId,System.currentTimeMillis())){WatcherScanStatus.checked(context,if(prefs.getBoolean("completed_capture_ok",false))"SLOT_COMPLETED"else"SLOT_PARTIAL");return@withTimeout}
                        begin()
                        suspend fun flush(){
                            repeat(220){
                                currentCoroutineContext().ensureActive()
                                if(!WatcherAutomation.enabled(context))return
                                if(remaining()<30_000){budgetReached=true;return}
                                val item=queue.next(credentials.deviceId,System.currentTimeMillis())?:return
                                val held=runCatching {
                                    val body=org.json.JSONObject(item.body);val group=body.getString("groupId")
                                    val row=SavedResultCodec.rows(org.json.JSONArray().put(body.getJSONObject("row")),group,true,body.optString("sourceType")=="PROFILE")?.singleOrNull()?:error("QUALITY_INVALID")
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
                        WatcherSources.setActive(groups)
                        WatcherScanSummary.start(context,slot,groups)
                        val groupCache=org.json.JSONObject().put("version",1).put("groups",org.json.JSONArray(groups.filter{it.type=="GROUP"}.map{org.json.JSONObject().put("groupId",it.id).put("url",it.url).put("name",it.name)})).toString()
                        check(context.getSharedPreferences("gecko_poc",Context.MODE_PRIVATE).edit().putString("watcher_active_groups",groupCache).commit())
                        // Start every new cycle at source 1. Durable receipts alone
                        // select the first unfinished source on continuation.
                        val ordered=groups
                        val activeKeys=groups.map{it.key}.toSet()
                        fun progressCounts()=ScanSourceProgress.count(activeKeys,queue.scannedSources(slot),queue.attemptedSources(slot))
                        fun updateCounts(change:(ScanState)->ScanState={it}){
                            val counts=progressCounts()
                            WatcherScanStatus.update(context,run){change(it).copy(total=groups.size,done=counts.closed,attempted=counts.attempted,retrying=counts.retrying)}
                        }
                        updateCounts()
                        for(group in ordered){
                            currentCoroutineContext().ensureActive()
                            if(WatcherAutomation.uiVisible||!WatcherAutomation.enabled(context))break
                            if(queue.scanned(slot,group.key))continue
                            if(remaining()<120_000){budgetReached=true;break}
                            queue.log((if(group.type=="PROFILE")"PROFILE_"else"GROUP_")+(groups.indexOf(group)+1))
                            check(prefs.edit().putString("last_attempted_source",group.key).commit())
                            queue.log("SCAN_STARTED")
                            WatcherScanStatus.update(context,run){it.copy(phase="LOADING",group=(if(group.type=="PROFILE")"Profil: "else "")+group.name,position=groups.indexOf(group)+1,reason="",groupStarted=System.currentTimeMillis())}
                            val groupClock=android.os.SystemClock.elapsedRealtime()
                            try {
                            val scanned=withTimeoutOrNull(sourceTimeoutMs(remaining())){
                                scan(group){phase->WatcherScanStatus.update(context,run){it.copy(phase=phase)}}
                            }?:error("SOURCE_TIMEOUT")
                            WatcherScanStatus.update(context,run){it.copy(phase="SAVING")}
                            val offers=scanned.rows.filter{DesktopSummary.eligible(it)||DesktopPresentation.reviewable(it)}
                            val ids=offers.map{it.postId}.toSet()
                            val result=scanned.copy(rows=offers,photos=scanned.photos.filter{it.postId in ids})
                            if(result.rows.isNotEmpty()){
                                // The encrypted automation database is independent: manual archives remain byte-for-byte intact.
                                // Frozen independent encrypted copies survive later scans and process death.
                                queue.enqueue(credentials.deviceId,group,result)
                            }
                            val issue=WatcherCaptureReport.issue(scanned)
                            renderFailures=0
                            WatcherScanSummary.source(context,slot,group,result.rows.size,issue)
                            val prior=queue.attemptedSources(slot).contains(group.key)
                            val evidence=WatcherCaptureReport.create(context,slot,run,group,scanned,issue,android.os.SystemClock.elapsedRealtime()-groupClock,queue.transferCounts())
                            queue.report(credentials.deviceId,slot,group.key,evidence)
                            // One bounded retry for degraded capture; do not spin forever on the same source.
                            if(SourceRetryPolicy.closeCapture(issue,prior)){queue.completeScan(slot,group.key);if(requested!=null)queue.completeScan(windowKey,group.key)}
                            else{lastIssue=issue;queue.log(issue)}
                            val diagnostic=queue.nextReport(credentials.deviceId)
                            if(diagnostic!=null)runCatching{sendReport(credentials,diagnostic);queue.reportSent(diagnostic.id)}
                            queue.log("SCAN_SAVED",result.rows.size)
                            updateCounts{it.copy(posts=it.posts+result.rows.size,photos=it.photos+result.photos.size)}
                            flush()
                            }catch(e:Exception){
                                // A source's own timeout must not cancel the entire cycle.
                                // Parent cancellation (including Android stopping the work) still propagates.
                                if(e is CancellationException){
                                    currentCoroutineContext().ensureActive()
                                    if(e !is TimeoutCancellationException)throw e
                                }
                                if(e is WatcherUpload.HttpFailure&&e.status in setOf(401,403))throw e
                                lastIssue=if(WatcherAutomation.uiVisible)"WAITING_FOR_BACKGROUND"else WatcherAutomation.errorCode(e)
                                queue.log(lastIssue)
                                WatcherScanSummary.source(context,slot,group,null,lastIssue)
                                val hadAttempt=queue.attemptedSources(slot).contains(group.key)
                                val evidence=WatcherCaptureReport.create(context,slot,run,group,null,lastIssue,android.os.SystemClock.elapsedRealtime()-groupClock,queue.transferCounts(),(e as? RenderEvidenceFailure)?.stats?:emptyMap())
                                runCatching{queue.report(credentials.deviceId,slot,group.key,evidence)}
                                val renderFailure=lastIssue in setOf("GROUP_RENDER_RETRY_FAILED","PROFILE_RENDER_RETRY_FAILED")
                                renderFailures=if(renderFailure)renderFailures+1 else 0
                                rendererPaused=renderFailures>=3
                                if(!rendererPaused&&SourceRetryPolicy.closeFailure(lastIssue,hadAttempt)){queue.completeScan(slot,group.key);if(requested!=null)queue.completeScan(windowKey,group.key)}
                                updateCounts{it.copy(phase="PREPARING",reason=lastIssue)}
                                if(rendererPaused){queue.log("RENDERER_UNAVAILABLE");break}
                                if(SourceRetryPolicy.pauseForNetwork(lastIssue)){networkPaused=true;break}
                                // A single unavailable group cannot starve every later source.
                                if(e.message in setOf("LOGIN_REQUIRED","CHECKPOINT","CAPTCHA"))break
                            }
                        }
                        val captureOk=queue.cycleReports(slot).let{r->r.size==groups.size&&r.all{it.optString("issue").isEmpty()}}
                        val allDone=groups.isNotEmpty()&&groups.all{queue.scanned(slot,it.key)}
                        if(!WatcherAutomation.uiVisible&&WatcherAutomation.enabled(context)){
                            if(groups.isEmpty()){lastIssue="NO_ACTIVE_GROUPS";queue.log(lastIssue)}
                            if(groups.isNotEmpty()&&groups.all{queue.scanned(windowKey,it.key)})check(prefs.edit().putString("completed_slot",windowKey).putBoolean("completed_capture_ok",captureOk).commit())
                            if(allDone&&requested!=null&&prefs.getString("requested_scan",null)==requested)
                                check(prefs.edit().remove("requested_scan").commit())
                        }
                        retryNeeded=!rendererPaused&&!networkPaused&&!allDone&&!WatcherAutomation.uiVisible&&WatcherAutomation.enabled(context)&&groups.isNotEmpty()&&lastIssue !in setOf("LOGIN_REQUIRED","CHECKPOINT","CAPTCHA")
                        val reason=when{!WatcherAutomation.enabled(context)->"AUTOMATION_DISABLED";WatcherAutomation.uiVisible->"WAITING_FOR_BACKGROUND";rendererPaused->"RENDERER_UNAVAILABLE";networkPaused->"NETWORK_DNS_UNAVAILABLE";budgetReached->"BATCH_CONTINUE";allDone&&!captureOk->"CAPTURE_PARTIAL";else->lastIssue}
                        val phase=when{!WatcherAutomation.enabled(context)->"ERROR";allDone&&captureOk->"DONE";allDone->"PARTIAL";WatcherAutomation.uiVisible->"WAITING_UI";networkPaused||budgetReached||retryNeeded->"RETRY";else->"PARTIAL"}
                        WatcherScanStatus.finish(context,run,phase,reason)
                    }
                    if(budgetReached||retryNeeded){
                        if(budgetReached)queue.log("BATCH_CONTINUE")
                        continueScan(context)
                    }
                    if(networkPaused)Result.retry()else Result.success()
                }catch(e:TimeoutCancellationException){
                    currentCoroutineContext().ensureActive()
                    queue.log("BATCH_CONTINUE")
                    if(begun)WatcherScanStatus.finish(context,run,"RETRY","BATCH_CONTINUE")
                    continueScan(context)
                    Result.success()
                }catch(e:CancellationException){
                    val stopped=interruptionReason()
                    queue.log("WORK_STOP_"+stopped.toString().replace("-","NEG_"))
                    val recover=begun&&WatcherAutomation.enabled(context)&&stopped!=WorkInfo.STOP_REASON_CANCELLED_BY_APP
                    val reason=when(stopped){
                        WorkInfo.STOP_REASON_CONSTRAINT_CONNECTIVITY->"INTERRUPTED_NETWORK"
                        WorkInfo.STOP_REASON_TIMEOUT->"INTERRUPTED_TIMEOUT"
                        WorkInfo.STOP_REASON_QUOTA->"INTERRUPTED_QUOTA"
                        WorkInfo.STOP_REASON_CANCELLED_BY_APP->"INTERRUPTED_CANCELLED"
                        else->"INTERRUPTED"
                    }
                    // Cancellation still propagates to WorkManager. A pending retry
                    // must not be shown as a terminal scan error or lose receipts.
                    if(recover){
                        recoverInterrupted(context)
                        WatcherScanStatus.finish(context,run,"RETRY",reason)
                    }else if(begun)WatcherScanStatus.finish(context,run,"ERROR",if(!WatcherAutomation.enabled(context))"AUTOMATION_DISABLED"else reason)
                    throw e
                }
                catch(e:Exception){val reason=if(e is WatcherUpload.HttpFailure)"UPLOAD_HTTP_"+e.status else WatcherAutomation.errorCode(e);queue.log(reason);begin();WatcherScanStatus.finish(context,run,"ERROR",reason);Result.retry()}
                finally{ticker?.cancel();runCatching{WatcherAutomation.scheduleNext(context)}}
            }
        }
    }
}
