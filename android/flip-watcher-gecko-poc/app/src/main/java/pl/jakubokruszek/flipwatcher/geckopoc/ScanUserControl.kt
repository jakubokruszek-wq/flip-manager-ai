package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import androidx.work.WorkManager
import org.json.JSONArray
import java.time.Instant
import java.time.ZoneId

/** Stops source reading for the current cycle only. Offers, receipts and login are retained. */
internal object ScanUserControl {
    private const val KEY="user_stopped_capture_cycles"
    private val cyclePattern=Regex("capture-2/[A-Za-z0-9_/:.+-]{1,120}")
    private fun cycles(context:Context):List<String> {
        val raw=WatcherAutomation.preferences(context).getString(KEY,null)?:return emptyList()
        if(raw.length>8192)return emptyList()
        return runCatching{JSONArray(raw).let{j->(0 until minOf(j.length(),32)).mapNotNull{i->j.optString(i).takeIf{cyclePattern.matches(it)}}}}.getOrDefault(emptyList())
    }
    fun isStopped(context:Context,slot:String)=slot.isNotEmpty()&&cycles(context).contains(slot)
    fun stop(context:Context,
             cancelUnique:(String)->Unit={WorkManager.getInstance(context).cancelUniqueWork(it);Unit},
             cancelTag:(String)->Unit={WorkManager.getInstance(context).cancelAllWorkByTag(it);Unit}):Set<String> {
        val prefs=WatcherAutomation.preferences(context)
        val target=linkedSetOf<String>()
        prefs.getString("capture_cycle",null)?.takeIf{cyclePattern.matches(it)}?.let(target::add)
        prefs.getString("requested_scan",null)?.let{request->WatcherCaptureReport.cycle("manual/$request").takeIf{cyclePattern.matches(it)}?.let(target::add)}
        val window=AutomationPolicy.current(Instant.now(),ZoneId.systemDefault(),WatcherAutomation.schedule(context))
        target.add(WatcherCaptureReport.cycle(window.key))
        // Also suppress another calendar check of THIS window after the manual
        // request is removed. Later calendar slots keep their own distinct keys.
        val keep=(cycles(context).filter{it !in target}+target).takeLast(32)
        check(prefs.edit().putString(KEY,JSONArray(keep).toString()).remove("requested_scan")
            .remove(ManualScanHandoff.KEY).remove("continuation_at").commit())
        WatcherScanStatus.userStopped(context)
        // Do not cancel the calendar or window tags: the current run may itself
        // be periodic, and cancelling its ID would remove future watchdog runs.
        for(name in listOf("watcher-retry-v1","watcher-background-kick-v2",WatcherAutomation.CONTINUATION_TAG,WatcherAutomation.RECOVERY_WORK))runCatching{cancelUnique(name)}
        runCatching{cancelTag(WatcherAutomation.CONTINUATION_TAG)}
        return target
    }
    fun restartFromZero(context:Context,
                        cancelUnique:(String)->Unit={WorkManager.getInstance(context).cancelUniqueWork(it);Unit},
                        cancelTag:(String)->Unit={WorkManager.getInstance(context).cancelAllWorkByTag(it);Unit}) {
        check(WatcherAutomation.enabled(context)){"AUTOMATION_DISABLED"}
        stop(context,cancelUnique,cancelTag)
        // New UUID means a new receipt namespace; old receipts and all frozen
        // photo/text bodies stay untouched instead of being deleted or reset.
        WatcherAutomation.requestScan(context)
    }
}
