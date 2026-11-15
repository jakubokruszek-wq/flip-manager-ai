package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Explicit single-source diagnostic after its Activity stops; never an offer scan. */
class RenderComparisonWorker(context:Context,parameters:WorkerParameters):CoroutineWorker(context,parameters){
    override suspend fun doWork():Result {
        val run=inputData.getString("run")?:return Result.failure()
        if(runCatching{UUID.fromString(run).toString()==run}.getOrDefault(false).not())return Result.failure()
        val group=runCatching{WatcherGroup(inputData.getString("group")?:error("GROUP"),(inputData.getString("name")?:"").take(200))}.getOrNull()?:return Result.failure()
        val width=inputData.getInt("width",0);val height=inputData.getInt("height",0)
        if(width !in 128..2160||height !in 128..2160||width.toLong()*height>4_000_000)return Result.failure()
        val experimental=inputData.getBoolean("runtimeLease",false)
        val foreground=inputData.getBoolean("foreground",false)
        val arm=if(foreground){if(experimental)6 else 5}else if(experimental)4 else 3
        var locked=false
        suspend fun blocked(issue:String):Result {
            if(!foreground&&runAttemptCount<2)return Result.retry()
            RenderComparisonStore.record(applicationContext,run,group,arm,RenderComparisonResult(issue,mapOf("comparisonAttempt" to runAttemptCount.coerceAtMost(100_000_000))))
            return Result.failure()
        }
        return try {
            if(isStopped)return Result.failure()
            if(foreground&&!RenderComparisonForegroundService.isActive(run,arm))return blocked("COMPARE_FGS_NOT_ACTIVE")
            if(!foreground&&RenderComparisonForegroundService.anyActive())return blocked("COMPARE_FGS_BASELINE_BUSY")
            if(WatcherAutomation.uiVisible||RenderComparisonVisibility.hasStartedActivity)return blocked("COMPARE_WAIT_UI")
            if(!WatcherAutomation.lock.tryLock())return blocked("COMPARE_BUSY")
            locked=true
            if(WatcherAutomation.uiVisible||RenderComparisonVisibility.hasStartedActivity)return blocked("COMPARE_WAIT_UI")
            val epoch=RenderComparisonVisibility.foregroundEpoch
            fun foregroundValid()=if(foreground)RenderComparisonForegroundService.isActive(run,arm)else !RenderComparisonForegroundService.anyActive()
            check(foregroundValid()){"COMPARE_FGS_NOT_ACTIVE"}
            val foregroundStart=if(foreground&&foregroundValid())1 else 0
            var lease:AutoCloseable?=null
            val before=withContext(Dispatchers.Main){GeckoBackgroundLease.snapshot()}
            val observed=try {
                if(experimental)withContext(NonCancellable+Dispatchers.Main){
                    check(foregroundValid()&&!isStopped&&!WatcherAutomation.uiVisible&&!RenderComparisonVisibility.hasStartedActivity&&RenderComparisonVisibility.foregroundEpoch==epoch){"COMPARE_INTERRUPTED"}
                    GeckoHost.runtime(applicationContext)
                    lease=GeckoBackgroundLease.acquire()
                }
                withTimeoutOrNull(90_000){
                    RenderComparisonProbe.run(applicationContext,group,null,width,height,{foregroundValid()&&!isStopped&&!WatcherAutomation.uiVisible&&!RenderComparisonVisibility.hasStartedActivity&&RenderComparisonVisibility.foregroundEpoch==epoch})
                }?:RenderComparisonResult("COMPARE_TIMEOUT",emptyMap())
            }finally{withContext(NonCancellable+Dispatchers.Main){lease?.close()}}
            val after=withContext(Dispatchers.Main){GeckoBackgroundLease.snapshot()}
            val result=observed.copy(stats=observed.stats+mapOf("comparisonForegroundRequested" to if(foreground)1 else 0,"comparisonForegroundAtStart" to foregroundStart,"comparisonForegroundAtEnd" to if(foreground&&foregroundValid())1 else 0,"comparisonRuntimeLease" to if(experimental)1 else 0,"comparisonLeasePausedBefore" to (before["leaseRuntimePaused"]?:0),"comparisonLeaseOwnersAfter" to (after["leaseOwners"]?:0),
                "comparisonLeaseResumes" to ((after["ownedNativeResumeCount"]?:0)-(before["ownedNativeResumeCount"]?:0)).coerceAtLeast(0),
                "comparisonLeaseRestores" to ((after["ownedNativePauseCount"]?:0)-(before["ownedNativePauseCount"]?:0)).coerceAtLeast(0)))
            RenderComparisonStore.record(applicationContext,run,group,arm,result)
            Result.success()
        }catch(e:CancellationException){throw e}catch(e:Exception){
            val issue=e.message?.takeIf{it.matches(Regex("[A-Z0-9_]{1,60}"))}?:"COMPARE_ERROR"
            RenderComparisonStore.record(applicationContext,run,group,arm,RenderComparisonResult(issue,emptyMap()))
            Result.failure()
        }finally{
            if(locked)WatcherAutomation.lock.unlock()
            if(foreground)withContext(NonCancellable+Dispatchers.Main){RenderComparisonForegroundService.stop(applicationContext,run,arm)}
        }
    }
    companion object {
        fun enqueue(context:Context,run:String,group:WatcherGroup,width:Int,height:Int,runtimeLease:Boolean=false,foreground:Boolean=false){
            require(UUID.fromString(run).toString()==run&&group.type=="GROUP")
            require(width in 128..2160&&height in 128..2160&&width.toLong()*height<=4_000_000)
            val input=Data.Builder().putString("run",run).putString("group",group.id).putString("name",group.name.take(200)).putInt("width",width).putInt("height",height).putBoolean("runtimeLease",runtimeLease).putBoolean("foreground",foreground).build()
            val work=OneTimeWorkRequestBuilder<RenderComparisonWorker>().setInputData(input)
                .setInitialDelay(2,TimeUnit.SECONDS).setBackoffCriteria(BackoffPolicy.LINEAR,10,TimeUnit.SECONDS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
            WorkManager.getInstance(context).enqueueUniqueWork("watcher-render-comparison-$run-${if(foreground){if(runtimeLease)6 else 5}else if(runtimeLease)4 else 3}",ExistingWorkPolicy.KEEP,work)
        }
    }
}
