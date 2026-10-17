package pl.jakubokruszek.flipcollector.integration

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import pl.jakubokruszek.flipcollector.watcher.WatchedGroup

class GroupSyncTest {
    private fun local(id: String, url: String, active: Boolean = true, remoteId: String? = null, origin: GroupOrigin = if (remoteId == null) GroupOrigin.LOCAL else GroupOrigin.SERVER) =
        SyncedGroup(WatchedGroup(id, "lokalna $id", url, active), origin, remoteId)

    private fun merge(local: List<SyncedGroup>, remote: List<RemoteGroup>) = GroupSync.merge(local, remote) { "new-${it.remoteId}" }

    @Test
    fun firstSyncAddsServerGroupsAndKeepsLocalOnes() {
        val (groups, report) = merge(
            listOf(local("l1", "https://www.facebook.com/groups/tylko-lokalna")),
            listOf(RemoteGroup("r1", "Łódź mieszkania", "https://www.facebook.com/groups/lodz", true)),
        )
        assertEquals(listOf("new-r1", "l1"), groups.map { it.group.id })
        assertEquals(GroupOrigin.SERVER, groups[0].origin)
        assertEquals(GroupOrigin.LOCAL, groups[1].origin)
        assertEquals(GroupSyncReport(added = 1, updated = 0, removedOnServer = 0, unchanged = 0), report)
    }

    @Test
    fun handAddedGroupIsAdoptedByUrlAndKeepsThePhoneSwitch() {
        val (groups, report) = merge(
            listOf(local("l1", "https://m.facebook.com/groups/lodz/", active = false)),
            listOf(RemoteGroup("r1", "Łódź mieszkania", "https://www.facebook.com/groups/lodz", true)),
        )
        val group = groups.single()
        assertEquals("l1", group.group.id)
        assertEquals("r1", group.remoteId)
        assertEquals("Łódź mieszkania", group.group.name)
        assertFalse("phone switch survives", group.group.active)
        assertFalse(group.scannable)
        assertEquals(1, report.updated)
    }

    @Test
    fun serverOwnsNameUrlAndEnabledButNotThePhoneSwitch() {
        val start = listOf(local("l1", "https://www.facebook.com/groups/a", active = true, remoteId = "r1"))
        val (groups, _) = merge(start, listOf(RemoteGroup("r1", "Nowa nazwa", "https://www.facebook.com/groups/a-nowy", enabled = false)))
        val g = groups.single()
        assertEquals("Nowa nazwa", g.group.name)
        assertEquals("https://www.facebook.com/groups/a-nowy", g.group.url)
        assertTrue(g.group.active)
        assertFalse("disabled on server → not scanned", g.scannable)
    }

    @Test
    fun groupMissingFromServerIsKeptMarkedAndNeverScanned() {
        val start = listOf(local("l1", "https://www.facebook.com/groups/a", remoteId = "r1"), local("l2", "https://www.facebook.com/groups/b", remoteId = "r2"))
        val (groups, report) = merge(start, listOf(RemoteGroup("r2", "B", "https://www.facebook.com/groups/b", true)))
        assertEquals(listOf("l2", "l1"), groups.map { it.group.id })
        assertEquals(GroupOrigin.REMOVED_ON_SERVER, groups[1].origin)
        assertFalse(groups[1].scannable)
        assertEquals(1, report.removedOnServer)
        // A second identical sync does not count it again.
        assertEquals(0, merge(groups, listOf(RemoteGroup("r2", "B", "https://www.facebook.com/groups/b", true))).second.removedOnServer)
    }

    @Test
    fun groupReappearingOnServerIsRestored() {
        val removed = listOf(local("l1", "https://www.facebook.com/groups/a", remoteId = "r1", origin = GroupOrigin.REMOVED_ON_SERVER))
        val (groups, _) = merge(removed, listOf(RemoteGroup("r1", "A", "https://www.facebook.com/groups/a", true)))
        assertEquals(GroupOrigin.SERVER, groups.single().origin)
        assertTrue(groups.single().scannable)
    }

    @Test
    fun repeatedSyncIsStable() {
        val remote = listOf(RemoteGroup("r1", "A", "https://www.facebook.com/groups/a", true), RemoteGroup("r2", "B", "https://www.facebook.com/groups/b", false))
        val (first, _) = merge(emptyList(), remote)
        val (second, report) = merge(first, remote)
        assertEquals(first, second)
        assertEquals(GroupSyncReport(added = 0, updated = 0, removedOnServer = 0, unchanged = 2), report)
    }

    @Test
    fun duplicateRemoteIdsAreIgnoredAfterTheFirst() {
        val (groups, _) = merge(emptyList(), listOf(RemoteGroup("r1", "A", "https://www.facebook.com/groups/a", true), RemoteGroup("r1", "A2", "https://www.facebook.com/groups/a2", true)))
        assertEquals(listOf("A"), groups.map { it.group.name })
    }

    @Test
    fun pendingSourceNeverReportsGroups() = runTest {
        assertEquals(GroupFetchResult.PendingContract, PendingContractGroupSource.fetch())
    }
}
