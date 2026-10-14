package pl.jakubokruszek.flipcollector.watcher

import org.junit.Assert.assertEquals
import org.junit.Test

/** Both scan modes: DEMO must run fully locally; LIVE keeps every authorisation and safety requirement. */
class ScanPreconditionsTest {
    private val strict = ScanSchedule.DEFAULT.copy(enabled = true) // Wi-Fi and charging required
    private val nothing = DeviceConditions(onWifi = false, charging = false, paired = false)
    private val ready = DeviceConditions(onWifi = true, charging = true, paired = true)
    private val groups = listOf(WatchedGroup("g1", "A", "https://www.facebook.com/groups/a"))

    private fun check(trigger: ScanTrigger, mode: ScanMode, conditions: DeviceConditions, liveAllowed: Boolean, groups: List<WatchedGroup> = this.groups, insideWindow: Boolean = true) =
        ScanPreconditions.evaluate(trigger, strict, conditions, groups, GroupSelection.AllActive, insideWindow, mode, liveAllowed)

    @Test
    fun manualDemoNeedsNoPairingNoWifiNoChargerAndNoGroups() {
        assertEquals(emptyList<ScanBlocker>(), check(ScanTrigger.MANUAL, ScanMode.DEMO, nothing, liveAllowed = false, groups = emptyList(), insideWindow = false))
    }

    @Test
    fun manualDemoIgnoresAutomationBeingOff() {
        val blockers = ScanPreconditions.evaluate(ScanTrigger.MANUAL, ScanSchedule.DEFAULT, nothing, emptyList(), GroupSelection.Single("missing"), insideWindow = false)
        assertEquals(emptyList<ScanBlocker>(), blockers)
    }

    @Test
    fun manualLiveRequiresEverythingAndReportsEachMissingPiece() {
        assertEquals(
            listOf(ScanBlocker.WIFI_REQUIRED, ScanBlocker.CHARGING_REQUIRED, ScanBlocker.LIVE_DISABLED, ScanBlocker.NOT_PAIRED, ScanBlocker.NO_GROUPS),
            check(ScanTrigger.MANUAL, ScanMode.LIVE, nothing, liveAllowed = false, groups = emptyList()),
        )
    }

    @Test
    fun liveStaysBlockedWithoutPairingEvenWhenAllowed() {
        assertEquals(listOf(ScanBlocker.NOT_PAIRED), check(ScanTrigger.MANUAL, ScanMode.LIVE, ready.copy(paired = false), liveAllowed = true))
    }

    @Test
    fun liveStaysBlockedWhileLiveCollectionIsNotAllowedEvenWhenPaired() {
        assertEquals(listOf(ScanBlocker.LIVE_DISABLED), check(ScanTrigger.MANUAL, ScanMode.LIVE, ready, liveAllowed = false))
    }

    @Test
    fun liveRunsOnlyWhenPairedAllowedAndConditionsHold() {
        assertEquals(emptyList<ScanBlocker>(), check(ScanTrigger.MANUAL, ScanMode.LIVE, ready, liveAllowed = true))
    }

    @Test
    fun automaticDemoFollowsTheScheduleButNotPairing() {
        assertEquals(listOf(ScanBlocker.WIFI_REQUIRED, ScanBlocker.CHARGING_REQUIRED), check(ScanTrigger.AUTOMATIC, ScanMode.DEMO, nothing, liveAllowed = false))
        assertEquals(emptyList<ScanBlocker>(), check(ScanTrigger.AUTOMATIC, ScanMode.DEMO, ready.copy(paired = false), liveAllowed = false, groups = emptyList()))
        assertEquals(listOf(ScanBlocker.OUTSIDE_WINDOW), check(ScanTrigger.AUTOMATIC, ScanMode.DEMO, ready, liveAllowed = false, insideWindow = false))
    }

    @Test
    fun automaticLiveAddsWindowAndAuthorisation() {
        assertEquals(
            listOf(ScanBlocker.OUTSIDE_WINDOW, ScanBlocker.LIVE_DISABLED, ScanBlocker.NOT_PAIRED),
            check(ScanTrigger.AUTOMATIC, ScanMode.LIVE, ready.copy(paired = false), liveAllowed = false, insideWindow = false),
        )
    }
}
