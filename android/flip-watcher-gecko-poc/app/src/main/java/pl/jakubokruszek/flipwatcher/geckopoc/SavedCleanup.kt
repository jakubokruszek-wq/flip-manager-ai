package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import java.time.LocalDate
import java.time.ZoneId

/** Selected date means its start in the phone timezone; records on that day are kept. */
object SavedCleanup {
    fun cutoff(day:LocalDate,zone:ZoneId=ZoneId.systemDefault()):Long {
        val value=day.atStartOfDay(zone).toInstant().toEpochMilli()
        require(value>0&&value<=System.currentTimeMillis())
        return value
    }
    data class Preview(val queue:WatcherOutbox.CleanupPreview,val archiveAt:Long?,val archiveRows:Int)
    fun preview(context:Context,group:String,before:Long):Preview {
        val archive=ResultArchive(context,group).load()
        val rows=if(archive!=null&&archive.savedAt<before)archive.rows.size else 0
        return WatcherOutbox(context).use{Preview(it.cleanupPreview(group,before),archive?.savedAt,rows)}
    }
    /** Caller owns WatcherAutomation.lock and blocks manual writes while applying. */
    fun apply(context:Context,group:String,before:Long,expected:Preview):Preview {
        check(preview(context,group,before)==expected){"CLEANUP_CHANGED"}
        WatcherOutbox(context).use{it.cleanup(group,before,expected.queue)}
        if(expected.archiveRows>0)ResultArchive(context,group).delete()
        return expected
    }
}
