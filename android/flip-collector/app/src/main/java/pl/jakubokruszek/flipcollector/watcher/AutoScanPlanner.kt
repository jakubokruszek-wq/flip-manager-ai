package pl.jakubokruszek.flipcollector.watcher

import java.time.ZonedDateTime

sealed interface AutoDecision {
    /** Nothing to do now; [blockers] say why (empty when the window was already served). */
    data class Wait(val blockers: List<ScanBlocker>) : AutoDecision
    /** Start one automatic scan for [window]. */
    data class Start(val window: ScanWindow, val groups: List<WatchedGroup>) : AutoDecision
}

/**
 * Decides what a periodic tick (WorkManager, about every 15 min) does. At
 * most one automatic scan per window: once a window's scan has started, its
 * key is stored and later ticks inside it wait. A tick blocked only by Wi-Fi
 * or charging does not consume the window, so the scan still runs once the
 * phone is plugged in before the window ends.
 */
object AutoScanPlanner {
    fun decide(
        now: ZonedDateTime,
        schedule: ScanSchedule,
        conditions: DeviceConditions,
        groups: List<WatchedGroup>,
        selection: GroupSelection,
        lastStartedWindowKey: String?,
        scanRunning: Boolean,
    ): AutoDecision {
        val window = schedule.windowContaining(now)
        val blockers = ScanPreconditions.evaluate(ScanTrigger.AUTOMATIC, schedule, conditions, groups, selection, insideWindow = window != null)
            .let { if (scanRunning) it + ScanBlocker.ALREADY_RUNNING else it }
        if (blockers.isNotEmpty() || window == null) return AutoDecision.Wait(blockers)
        if (window.key == lastStartedWindowKey) return AutoDecision.Wait(emptyList())
        return AutoDecision.Start(window, selection.resolve(groups))
    }
}
