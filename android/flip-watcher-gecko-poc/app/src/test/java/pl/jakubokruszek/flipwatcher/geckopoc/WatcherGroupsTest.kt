package pl.jakubokruszek.flipwatcher.geckopoc

import org.junit.Assert.*
import org.junit.Before
import org.junit.After
import org.junit.Test

class WatcherGroupsTest {
    @Before fun before(){WatcherGroups.setActive(WatcherGroups.configured);PocPolicy.selectGroup(WatcherGroups.LEGACY_GROUP)}
    @After fun reset(){WatcherGroups.setActive(WatcherGroups.configured);PocPolicy.selectGroup(WatcherGroups.LEGACY_GROUP)}
    @Test fun watcherSnapshotExcludesDisabledGroupsAndProfiles(){
        assertEquals(11,WatcherGroups.configured.size)
        assertEquals(11,WatcherGroups.configured.map{it.id}.toSet().size)
        assertNull(WatcherGroups.find("870957041215365"));assertNull(WatcherGroups.find("2928219830782023"))
        assertNull(WatcherGroups.find("61563667387467"))
    }
    @Test fun exactIdentityIsRequiredForEveryGroupAndPost(){
        for(group in WatcherGroups.configured){
            PocPolicy.selectGroup(group.id)
            assertEquals(PageKind.APPROVED_GROUP,PocPolicy.classify(group.url))
            assertEquals(PageKind.APPROVED_POST,PocPolicy.classify(group.url+"posts/550000000000099/"))
            for(other in WatcherGroups.configured.filter{it.id!=group.id}){
                assertEquals(PageKind.OTHER_GROUP,PocPolicy.classify(other.url))
                assertEquals(PageKind.OTHER_GROUP,PocPolicy.classify(other.url+"posts/550000000000099/"))
            }
        }
    }
    @Test fun dotsAreLiteralAndUnknownSourcesCannotBeSelected(){
        PocPolicy.selectGroup("mieszkania.na.sprzedaz.lodz")
        assertEquals(PageKind.OTHER_GROUP,PocPolicy.classify("https://www.facebook.com/groups/mieszkaniaXnaXsprzedazXlodz/posts/550000000000099/"))
        assertTrue(runCatching{PocPolicy.selectGroup("foreign")}.isFailure)
        assertEquals("mieszkania.na.sprzedaz.lodz",PocPolicy.APPROVED_GROUP_ID)
    }
    @Test fun loginTargetTracksSelectedGroupAndLegacyArchiveKeepsItsFilename(){
        val filenames=WatcherGroups.configured.map{WatcherGroups.archiveFile(it.id)}
        assertEquals(11,filenames.toSet().size);assertEquals("saved-search-v1.bin",WatcherGroups.archiveFile(WatcherGroups.LEGACY_GROUP))
        PocPolicy.selectGroup("402796264871862")
        assertTrue(java.net.URLDecoder.decode(PocPolicy.LOGIN_URL,"UTF-8").endsWith(PocPolicy.APPROVED_GROUP_URL))
        assertFalse(PocPolicy.LOGIN_URL.contains(WatcherGroups.LEGACY_GROUP))
        assertTrue(runCatching{WatcherGroups.archiveFile("../other")}.isFailure)
    }
}
