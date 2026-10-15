package pl.jakubokruszek.flipcollector.watcher

import java.time.Instant
import java.time.ZoneId

/** Figures for the Facebook Watcher home screen, derived from the local history. */
data class ScanSummary(
    val lastSuccessful: ScanRecord?,
    val lastScan: ScanRecord?,
    val offersToday: Int,
    val scansToday: Int,
    val lastError: String?,
) {
    companion object {
        /** [history] is newest first. "Today" is the calendar day in [zone]. */
        fun from(history: List<ScanRecord>, now: Instant, zone: ZoneId = WARSAW): ScanSummary {
            val today = now.atZone(zone).toLocalDate()
            val todays = history.filter { record -> runCatching { Instant.parse(record.startedAt).atZone(zone).toLocalDate() == today }.getOrDefault(false) }
            val lastError = history.firstOrNull { it.errors > 0 || it.outcome == ScanOutcome.FAILED || it.outcome == ScanOutcome.TIMED_OUT }
            return ScanSummary(
                lastSuccessful = history.firstOrNull { it.outcome.successful },
                lastScan = history.firstOrNull(),
                offersToday = todays.sumOf { it.offersFound },
                scansToday = todays.size,
                lastError = lastError?.message,
            )
        }
    }
}
