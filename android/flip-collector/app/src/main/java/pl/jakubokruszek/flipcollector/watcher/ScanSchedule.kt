package pl.jakubokruszek.flipcollector.watcher

import java.time.DayOfWeek
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

val WARSAW: ZoneId = ZoneId.of("Europe/Warsaw")

/**
 * Local scan window of the Facebook Watcher. Times are wall-clock minutes in
 * [zone]. A window whose end is not after its start crosses midnight and
 * belongs to the day it starts on: Monday 23:00–02:00 runs into Tuesday.
 */
data class ScanSchedule(
    val enabled: Boolean = false,
    val startMinutes: Int = 2 * 60,
    val endMinutes: Int = 5 * 60,
    val days: Set<DayOfWeek> = DayOfWeek.entries.toSet(),
    val requireWifi: Boolean = true,
    val requireCharging: Boolean = true,
    val zone: ZoneId = WARSAW,
) {
    init {
        require(startMinutes in 0 until MINUTES_PER_DAY) { "startMinutes out of range" }
        require(endMinutes in 0 until MINUTES_PER_DAY) { "endMinutes out of range" }
    }

    val crossesMidnight: Boolean get() = endMinutes <= startMinutes

    /** The window that contains [now], or null. Never depends on [enabled]. */
    fun windowContaining(now: ZonedDateTime): ScanWindow? {
        val local = now.withZoneSameInstant(zone)
        // A window that crosses midnight may have started yesterday.
        for (startDate in listOf(local.toLocalDate(), local.toLocalDate().minusDays(1))) {
            val window = windowStartingOn(startDate) ?: continue
            if (!now.toInstant().isBefore(window.start.toInstant()) && now.toInstant().isBefore(window.end.toInstant())) return window
        }
        return null
    }

    fun isWithinWindow(now: ZonedDateTime): Boolean = windowContaining(now) != null

    /** The first window that has not ended yet at [now] (the current one included). */
    fun nextWindow(now: ZonedDateTime): ScanWindow? {
        if (days.isEmpty()) return null
        windowContaining(now)?.let { return it }
        val today = now.withZoneSameInstant(zone).toLocalDate()
        for (offset in 0L..7L) {
            val window = windowStartingOn(today.plusDays(offset)) ?: continue
            if (window.start.toInstant().isAfter(now.toInstant())) return window
        }
        return null
    }

    /**
     * Window starting on [date], or null when [date] is not a selected day.
     * A wall-clock time that does not exist (spring-forward gap, 02:00–03:00
     * in Warsaw) moves forward by the gap; an ambiguous time (autumn
     * overlap) uses its earlier offset — both as [ZonedDateTime.of] does.
     */
    fun windowStartingOn(date: LocalDate): ScanWindow? {
        if (date.dayOfWeek !in days) return null
        val start = ZonedDateTime.of(LocalDateTime.of(date, time(startMinutes)), zone)
        val endDate = if (crossesMidnight) date.plusDays(1) else date
        val end = ZonedDateTime.of(LocalDateTime.of(endDate, time(endMinutes)), zone)
        // Both ends inside one spring-forward gap collapse to the same instant.
        if (!end.isAfter(start)) return null
        return ScanWindow(start, end)
    }

    companion object {
        const val MINUTES_PER_DAY = 24 * 60
        val DEFAULT = ScanSchedule()

        fun time(minutes: Int): LocalTime = LocalTime.of(minutes / 60, minutes % 60)
        fun format(minutes: Int): String = "%02d:%02d".format(minutes / 60, minutes % 60)
    }
}

data class ScanWindow(val start: ZonedDateTime, val end: ZonedDateTime) {
    /** Stable key of the window, used to report one automatic tick per window. */
    val key: String get() = start.toOffsetDateTime().toString()
}
