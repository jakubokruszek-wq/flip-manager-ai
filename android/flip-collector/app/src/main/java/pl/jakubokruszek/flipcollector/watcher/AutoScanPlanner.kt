package pl.jakubokruszek.flipcollector.watcher

import java.time.ZonedDateTime

sealed interface AutoDecision {
    /** Nothing to do now; [blockers] say why. */
    data class Wait(val blockers: List<ScanBlocker>) : AutoDecision
    /** Start one automatic scan for [window] over [groups]; [attempt] is 1 for the first try, 2 for the retry after an interruption. */
    data class Start(val window: ScanWindow, val groups: List<WatchedGroup>, val attempt: Int = 1) : AutoDecision
}

/**
 * Decides what a periodic tick (WorkManager, about every 15 min) does, using
 * the [WindowLedger]:
 *
 * - no entry for the window → first attempt;
 * - FINISHED → the window is used, wait for the next one;
 * - INTERRUPTED (or STARTED with no scan running, i.e. the process died) →
 *   one retry while the window is open, then wait;
 * - a tick blocked only by Wi-Fi or charging does not touch the ledger, so
 *   the scan still runs once the phone is plugged in before the window ends.
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
        ledger: List<WindowEntry>,
        scanRunning: Boolean,
        mode: ScanMode = ScanMode.DEMO,
        liveAllowed: Boolean = false,
        demoGroups: List<WatchedGroup> = DemoData.groups,
    ): AutoDecision {
        val window = schedule.windowContaining(now)
        val blockers = ScanPreconditions.evaluate(ScanTrigger.AUTOMATIC, schedule, conditions, groups, selection, insideWindow = window != null, mode = mode, liveAllowed = liveAllowed)
            .let { if (scanRunning) it + ScanBlocker.ALREADY_RUNNING else it }
        if (blockers.isNotEmpty() || window == null) return AutoDecision.Wait(blockers)
        val entry = ledger.firstOrNull { it.key == window.key }
        val attempt = if (entry == null) 1 else when (entry.status) {
            WindowStatus.FINISHED -> return AutoDecision.Wait(listOf(ScanBlocker.WINDOW_FINISHED))
            WindowStatus.STARTED, WindowStatus.INTERRUPTED ->
                if (entry.attempts >= WindowLedger.MAX_ATTEMPTS) return AutoDecision.Wait(listOf(ScanBlocker.WINDOW_RETRIES_EXHAUSTED)) else entry.attempts + 1
        }
        return AutoDecision.Start(window, if (mode == ScanMode.DEMO) demoGroups else selection.resolve(groups), attempt)
    }
}
