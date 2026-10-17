package pl.jakubokruszek.flipcollector.watcher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZonedDateTime

class AutoScanPlannerTest {
    private val groups = listOf(
        WatchedGroup("g1", "A", "https://www.facebook.com/groups/a"),
        WatchedGroup("g2", "B", "https://www.facebook.com/groups/b", active = false),
        WatchedGroup("g3", "C", "https://www.facebook.com/groups/c"),
    )
    private val ready = DeviceConditions(onWifi = true, charging = true, paired = true)
    private val enabled = ScanSchedule.DEFAULT.copy(enabled = true)
    private val inside = ZonedDateTime.parse("2026-10-14T02:30:00+02:00[Europe/Warsaw]")
    private val outside = ZonedDateTime.parse("2026-10-14T12:00:00+02:00[Europe/Warsaw]")

    private fun decide(
        now: ZonedDateTime = inside,
        schedule: ScanSchedule = enabled,
        conditions: DeviceConditions = ready,
        selection: GroupSelection = GroupSelection.AllActive,
        last: String? = null,
        running: Boolean = false,
        mode: ScanMode = ScanMode.LIVE,
        liveAllowed: Boolean = true,
    ) = AutoScanPlanner.decide(now, schedule, conditions, groups, selection, finishedLedger(last), running, mode, liveAllowed)

    /** A ledger in which window [key] already finished, or an empty one. */
    private fun finishedLedger(key: String?): List<WindowEntry> {
        if (key == null) return emptyList()
        val at = java.time.Instant.parse("2026-10-14T00:00:00Z")
        return WindowLedger.finished(WindowLedger.started(emptyList(), key, at), key, ScanOutcome.COMPLETED, at)
    }

    @Test
    fun startsInsideTheWindowWithActiveGroupsOnly() {
        val decision = decide() as AutoDecision.Start
        assertEquals(listOf("g1", "g3"), decision.groups.map { it.id })
    }

    @Test
    fun singleSelectionScansOnlyThatGroup() {
        val decision = decide(selection = GroupSelection.Single("g3")) as AutoDecision.Start
        assertEquals(listOf("g3"), decision.groups.map { it.id })
    }

    @Test
    fun selectingAnInactiveGroupBlocksWithNoGroups() {
        assertEquals(AutoDecision.Wait(listOf(ScanBlocker.NO_GROUPS)), decide(selection = GroupSelection.Single("g2")))
    }

    @Test
    fun disabledAutomationWaits() {
        val decision = decide(schedule = ScanSchedule.DEFAULT) as AutoDecision.Wait
        assertTrue(ScanBlocker.AUTOMATION_DISABLED in decision.blockers)
    }

    @Test
    fun outsideTheWindowWaits() {
        assertEquals(AutoDecision.Wait(listOf(ScanBlocker.OUTSIDE_WINDOW)), decide(now = outside))
    }

    @Test
    fun missingWifiOrChargerWaitsWithoutConsumingTheWindow() {
        assertEquals(AutoDecision.Wait(listOf(ScanBlocker.WIFI_REQUIRED, ScanBlocker.CHARGING_REQUIRED)), decide(conditions = ready.copy(onWifi = false, charging = false)))
        // Later in the same window the phone is plugged in: the scan starts.
        assertTrue(decide(now = inside.plusHours(1)) is AutoDecision.Start)
    }

    @Test
    fun wifiAndChargingAreIgnoredWhenNotRequired() {
        val relaxed = enabled.copy(requireWifi = false, requireCharging = false)
        assertTrue(decide(schedule = relaxed, conditions = ready.copy(onWifi = false, charging = false)) is AutoDecision.Start)
    }

    @Test
    fun aWindowIsServedOnlyOnce() {
        val start = decide() as AutoDecision.Start
        assertEquals(AutoDecision.Wait(listOf(ScanBlocker.WINDOW_FINISHED)), decide(now = inside.plusMinutes(45), last = start.window.key))
        // The next night is a new window.
        assertTrue(decide(now = inside.plusDays(1), last = start.window.key) is AutoDecision.Start)
    }

    @Test
    fun aRunningScanBlocksTheTick() {
        assertEquals(AutoDecision.Wait(listOf(ScanBlocker.ALREADY_RUNNING)), decide(running = true))
    }

    @Test
    fun unpairedPhoneWaits() {
        assertEquals(AutoDecision.Wait(listOf(ScanBlocker.NOT_PAIRED)), decide(conditions = ready.copy(paired = false)))
    }

    @Test
    fun demoModeScansTheBundledDemoGroupWithoutPairingOrRealGroups() {
        val decision = decide(conditions = ready.copy(paired = false), selection = GroupSelection.Single("missing"), mode = ScanMode.DEMO, liveAllowed = false) as AutoDecision.Start
        assertEquals(listOf(DemoData.GROUP_ID), decision.groups.map { it.id })
    }

    @Test
    fun demoModeStillHonoursWindowWifiAndCharging() {
        assertEquals(AutoDecision.Wait(listOf(ScanBlocker.OUTSIDE_WINDOW)), decide(now = outside, mode = ScanMode.DEMO))
        assertEquals(AutoDecision.Wait(listOf(ScanBlocker.CHARGING_REQUIRED)), decide(conditions = ready.copy(charging = false), mode = ScanMode.DEMO))
    }

    @Test
    fun liveModeIsBlockedWhileLiveCollectionIsNotAllowed() {
        assertEquals(AutoDecision.Wait(listOf(ScanBlocker.LIVE_DISABLED)), decide(liveAllowed = false))
    }

    @Test
    fun manualLiveScanIgnoresWindowAndAutomationButNotWifiOrCharging() {
        val blockers = ScanPreconditions.evaluate(ScanTrigger.MANUAL, ScanSchedule.DEFAULT, ready.copy(charging = false), groups, GroupSelection.AllActive, insideWindow = false, mode = ScanMode.LIVE, liveAllowed = true)
        assertEquals(listOf(ScanBlocker.CHARGING_REQUIRED), blockers)
    }
}
