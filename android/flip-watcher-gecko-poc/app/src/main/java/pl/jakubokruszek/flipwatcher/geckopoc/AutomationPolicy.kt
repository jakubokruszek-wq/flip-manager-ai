package pl.jakubokruszek.flipwatcher.geckopoc

import java.time.Instant
import java.time.ZoneId
import java.security.MessageDigest

/** Three local calendar windows, including DST and clock/time-zone changes. */
object AutomationPolicy {
    val hours = listOf(7, 15, 23)
    fun next(now: Instant, zone: ZoneId): Instant {
        val day = now.atZone(zone).toLocalDate()
        return (0L..2L).flatMap { offset -> hours.map { hour ->
            day.plusDays(offset).atTime(hour, 0).atZone(zone).toInstant()
        }}.filter { it > now }.min()
    }
    fun slot(now: Instant, zone: ZoneId): String {
        val local=now.atZone(zone)
        val hour=hours.lastOrNull { it<=local.hour }
        return if(hour==null) "${local.toLocalDate().minusDays(1)}/23" else "${local.toLocalDate()}/$hour"
    }
    fun digest(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    fun retryDelay(attempt: Int): Long = (30_000L * (1L shl attempt.coerceIn(0,10))).coerceAtMost(6*60*60*1000L)
}
