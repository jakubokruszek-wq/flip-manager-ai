package pl.jakubokruszek.flipwatcher.geckopoc

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.security.MessageDigest

/** Three local calendar times. A fall-back overlap runs once; a spring gap moves forward. */
object AutomationPolicy {
    val defaultMinutes = listOf(7*60, 15*60, 23*60)
    data class Window(val key:String,val at:Instant)
    fun validate(values:List<Int>):List<Int> {
        require(values.size==3&&values.distinct().size==3&&values.all{it in 0..1439}){"SCHEDULE_INVALID"}
        return values.sorted()
    }
    fun encode(values:List<Int>)=validate(values).joinToString(",")
    fun decode(raw:String?):List<Int> = if(raw==null)defaultMinutes else validate(raw.split(',').map{it.toIntOrNull()?:error("SCHEDULE_INVALID")})
    fun label(minute:Int):String {require(minute in 0..1439);return "%02d:%02d".format(java.util.Locale.ROOT,minute/60,minute%60)}
    private fun window(day:LocalDate,minute:Int,zone:ZoneId):Window {
        // Keep the 0.5.68 ledger keys for whole hours, so updating cannot replay a completed slot.
        val key=if(minute%60==0)"$day/${minute/60}" else "$day/${label(minute)}"
        return Window(key,day.atTime(minute/60,minute%60).atZone(zone).toInstant())
    }
    fun current(now:Instant,zone:ZoneId,minutes:List<Int> = defaultMinutes):Window {
        val day=now.atZone(zone).toLocalDate();val times=validate(minutes)
        return (-2L..0L).flatMap{offset->times.map{window(day.plusDays(offset),it,zone)}}
            .filter{it.at<=now}.maxBy{it.at}
    }
    fun next(now:Instant,zone:ZoneId,minutes:List<Int> = defaultMinutes):Instant {
        val day=now.atZone(zone).toLocalDate();val times=validate(minutes)
        return (0L..2L).flatMap{offset->times.map{window(day.plusDays(offset),it,zone)}}
            .filter{it.at>now}.minOf{it.at}
    }
    fun slot(now:Instant,zone:ZoneId,minutes:List<Int> = defaultMinutes)=current(now,zone,minutes).key
    fun digest(bytes:ByteArray):String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    fun retryDelay(attempt:Int):Long = (30_000L*(1L shl attempt.coerceIn(0,10))).coerceAtMost(6*60*60*1000L)
}
