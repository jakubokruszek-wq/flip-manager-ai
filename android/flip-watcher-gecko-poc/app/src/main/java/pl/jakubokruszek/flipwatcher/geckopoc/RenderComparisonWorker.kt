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
        suspend fun blocked(issue:String):Result {
            if(runAttemptCount<2)return Result.retry()
            RenderComparisonStore.record(applicationContext,run,group,3,RenderComparisonResult(issue,mapOf("comparisonAttempt" to runAttemptCount.coerceAtMost(100_000_000))))
            return Result.failure()
        }
        if(isStopped)return Result.failure()
        if(WatcherAutomation.uiVisible||RenderComparisonVisibility.hasStartedActivity)return blocked("COMPARE_WAIT_UI")
        if(!WatcherAutomation.lock.tryLock())return blocked("COMPARE_BUSY")
        return try {
            if(WatcherAutomation.uiVisible||RenderComparisonVisibility.hasStartedActivity)return blocked("COMPARE_WAIT_UI")
            val epoch=RenderComparisonVisibility.foregroundEpoch
            val result=withTimeoutOrNull(90_000){
                RenderComparisonProbe.run(applicationContext,group,null,width,height,{!isStopped&&!WatcherAutomation.uiVisible&&!RenderComparisonVisibility.hasStartedActivity&&RenderComparisonVisibility.foregroundEpoch==epoch})
            }?:RenderComparisonResult("COMPARE_TIMEOUT",emptyMap())
            RenderComparisonStore.record(applicationContext,run,group,3,result)
            Result.success()
        }catch(e:CancellationException){throw e}catch(e:Exception){
            val issue=e.message?.takeIf{it.matches(Regex("[A-Z0-9_]{1,60}"))}?:"COMPARE_ERROR"
            RenderComparisonStore.record(applicationContext,run,group,3,RenderComparisonResult(issue,emptyMap()))
            Result.failure()
        }finally{WatcherAutomation.lock.unlock()}
    }
    companion object {
        fun enqueue(context:Context,run:String,group:WatcherGroup,width:Int,height:Int){
            require(UUID.fromString(run).toString()==run&&group.type=="GROUP")
            require(width in 128..2160&&height in 128..2160&&width.toLong()*height<=4_000_000)
            val input=Data.Builder().putString("run",run).putString("group",group.id).putString("name",group.name.take(200)).putInt("width",width).putInt("height",height).build()
            val work=OneTimeWorkRequestBuilder<RenderComparisonWorker>().setInputData(input)
                .setInitialDelay(2,TimeUnit.SECONDS).setBackoffCriteria(BackoffPolicy.LINEAR,10,TimeUnit.SECONDS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
            WorkManager.getInstance(context).enqueueUniqueWork("watcher-render-comparison-$run",ExistingWorkPolicy.KEEP,work)
        }
    }
}
