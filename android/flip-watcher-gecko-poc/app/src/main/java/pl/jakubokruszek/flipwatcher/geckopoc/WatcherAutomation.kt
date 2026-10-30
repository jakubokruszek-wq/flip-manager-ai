package pl.jakubokruszek.flipwatcher.geckopoc

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import androidx.core.app.NotificationCompat
import androidx.work.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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
    fun configure(context:Context,enabled:Boolean){
        check(preferences(context).edit().putBoolean("enabled",enabled).commit())
        val manager=WorkManager.getInstance(context)
        if(enabled){
            // Android restores persistent work after reboot/package replacement. A cheap tick
            // follows calendar slots, avoiding 24-hour drift through DST/time-zone changes.
            val work=PeriodicWorkRequestBuilder<WatcherAutomationWorker>(15,TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
            manager.enqueueUniquePeriodicWork("watcher-calendar-v1",ExistingPeriodicWorkPolicy.KEEP,work)
            retry(context)
        }else{
            manager.cancelUniqueWork("watcher-calendar-v1");manager.cancelUniqueWork("watcher-retry-v1")
        }
    }
    fun retry(context:Context){
        WorkManager.getInstance(context).enqueueUniqueWork("watcher-retry-v1",ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<WatcherAutomationWorker>().setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
    }
    fun foreground(context:Context):ForegroundInfo {
        val manager=context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("watcher-automation","Automat Flip Watcher",NotificationManager.IMPORTANCE_LOW))
        val open=PendingIntent.getActivity(context,90,Intent(context,PocActivity::class.java),PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification=NotificationCompat.Builder(context,"watcher-automation").setSmallIcon(android.R.drawable.ic_menu_search)
            .setContentTitle("Flip Watcher").setContentText("Skanowanie grup i wysyłka zapisanych ofert").setContentIntent(open).setOngoing(true).build()
        return ForegroundInfo(90,notification,ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    }
}

class WatcherAutomationWorker(context:Context,parameters:WorkerParameters):CoroutineWorker(context,parameters) {
    override suspend fun doWork():Result=WatcherAutomation.lock.withLock {
        val context=applicationContext
        if(!BuildConfig.LIVE_UPLOAD_ENABLED||!WatcherAutomation.enabled(context))return@withLock Result.success()
        withContext(Dispatchers.IO){
            WatcherOutbox(context).use { queue ->
                try {
                    withTimeout(12*60*1000L){
                        val credentials=WatcherLink.load(context)?:error("PAIRING_REQUIRED")
                        // UI owns its browser/profile while visible. Retry on the next tick.
                        if(WatcherAutomation.uiVisible)return@withTimeout
                        val slot=AutomationPolicy.slot(Instant.now(),ZoneId.systemDefault())
                        val prefs=WatcherAutomation.preferences(context)
                        val alreadyCompleted=prefs.getString("completed_slot",null)==slot
                        if(alreadyCompleted&&!queue.hasDue(credentials.deviceId,System.currentTimeMillis()))return@withTimeout
                        setForeground(WatcherAutomation.foreground(context))
                        suspend fun flush(){
                            repeat(220){
                                currentCoroutineContext().ensureActive()
                                if(!WatcherAutomation.enabled(context))return
                                val item=queue.next(credentials.deviceId,System.currentTimeMillis())?:return
                                try{val receipt=WatcherUpload.send(credentials,item);queue.acknowledge(item.id,receipt);queue.log("UPLOAD_ACK")}
                                catch(e:WatcherUpload.HttpFailure){
                                    queue.defer(item,e.status in 400..499&&e.status !in setOf(408,429))
                                    queue.log("UPLOAD_HTTP_"+e.status)
                                    if(e.status in setOf(401,403))throw e
                                }catch(e:CancellationException){throw e}
                                catch(_:Exception){queue.defer(item);queue.log("UPLOAD_RETRY");return}
                            }
                        }
                        flush()
                        if(alreadyCompleted)return@withTimeout
                        val groups=WatcherLink.groups(credentials,verifyDevice=true)
                        for(group in groups){
                            currentCoroutineContext().ensureActive()
                            if(WatcherAutomation.uiVisible||!WatcherAutomation.enabled(context))break
                            if(queue.scanned(slot,group.id))continue
                            queue.log("SCAN_STARTED")
                            val scanned=BackgroundWatcherScan(context).run(group){!WatcherAutomation.uiVisible&&WatcherAutomation.enabled(context)}
                            val offers=scanned.rows.filter{DesktopSummary.eligible(it)||DesktopPresentation.reviewable(it)}
                            val ids=offers.map{it.postId}.toSet()
                            val result=scanned.copy(rows=offers,photos=scanned.photos.filter{it.postId in ids})
                            if(result.rows.isNotEmpty()){
                                // The encrypted automation database is independent: manual archives remain byte-for-byte intact.
                                // Frozen independent encrypted copies survive later scans and process death.
                                queue.enqueue(credentials.deviceId,group,result)
                            }
                            queue.completeScan(slot,group.id);queue.log("SCAN_SAVED",result.rows.size)
                            flush()
                        }
                        if(!WatcherAutomation.uiVisible&&WatcherAutomation.enabled(context)&&groups.all{queue.scanned(slot,it.id)})
                            check(prefs.edit().putString("completed_slot",slot).commit())
                    }
                    Result.success()
                }catch(e:CancellationException){queue.log("INTERRUPTED");throw e}
                catch(e:Exception){queue.log(e.message?.takeIf{it.matches(Regex("[A-Z0-9_]{1,60}"))}?:"AUTOMATION_RETRY");Result.retry()}
            }
        }
    }
}
