package pl.jakubokruszek.flipcollector.watcher

import java.time.ZonedDateTime

sealed interface AutoDecision {
    /** Nothing to do now; [blockers] say why (empty when the window was already served). */
    data class Wait(val blockers: List<ScanBlocker>) : AutoDecision
    /** Start one automatic scan for [window] over [groups]. */
    data class Start(val window: ScanWindow, val groups: List<WatchedGroup>) : AutoDecision
}

/**
 * Decides what a periodic tick (WorkManager, about every 15 min) does. At
 * most one automatic scan per window: once a window's scan has started, its
 * key is stored and later ticks inside it wait. A tick blocked only by Wi-Fi
 * or charging does not consume the window, so the scan still runs once the
 * phone is plugged in before the window ends.
 *
 * In [ScanMode.DEMO] the scan covers [demoGroups] (bundled test data); in
 * [ScanMode.LIVE] it covers the user's [selection] of [groups].
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
        mode: ScanMode = ScanMode.DEMO,
        liveAllowed: Boolean = false,
        demoGroups: List<WatchedGroup> = DemoData.groups,
    ): AutoDecision {
        val window = schedule.windowContaining(now)
        val blockers = ScanPreconditions.evaluate(ScanTrigger.AUTOMATIC, schedule, conditions, groups, selection, insideWindow = window != null, mode = mode, liveAllowed = liveAllowed)
            .let { if (scanRunning) it + ScanBlocker.ALREADY_RUNNING else it }
        if (blockers.isNotEmpty() || window == null) return AutoDecision.Wait(blockers)
        if (window.key == lastStartedWindowKey) return AutoDecision.Wait(emptyList())
        return AutoDecision.Start(window, if (mode == ScanMode.DEMO) demoGroups else selection.resolve(groups))
    }
}
