package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.After
import org.junit.Before
import org.junit.Test

class WatcherLinkTest {
    private fun pairing()=JSONObject().put("apiUrl",WatcherLink.ORIGIN).put("deviceId","12345678-1234-1234-1234-123456789012").put("deviceToken","A".repeat(43))
    private fun feed(vararg ids:String)=JSONObject().put("version",1).put("groups",JSONArray(ids.map{JSONObject().put("groupId",it).put("name","Łódź").put("url","https://www.facebook.com/groups/$it/")}))
    @Before fun before(){WatcherGroups.setActive(WatcherGroups.configured)}
    @After fun after(){WatcherGroups.setActive(WatcherGroups.configured);PocPolicy.selectGroup(WatcherGroups.LEGACY_GROUP)}
    @Test fun pairingIsBoundToExactManagerOriginAndRedacted(){
        val value=WatcherLink.parsePairing(pairing().toString());assertEquals("A".repeat(43),value.token);assertFalse(value.toString().contains(value.token))
        for(url in listOf("https://evil.test",WatcherLink.ORIGIN+".evil.test",WatcherLink.ORIGIN+"/",WatcherLink.ORIGIN+":444","http://flip-manager-ai.vercel.app"))assertTrue(runCatching{WatcherLink.parsePairing(pairing().put("apiUrl",url).toString())}.isFailure)
    }
    @Test fun malformedCodesAndUnexpectedSecretFieldsAreRejected(){
        for(value in listOf(pairing().put("deviceId","bad"),pairing().put("deviceToken","short"),pairing().put("deviceToken","A".repeat(129)),pairing().put("cookie","not-allowed")))assertTrue(runCatching{WatcherLink.parsePairing(value.toString())}.isFailure)
    }
    @Test fun feedPreservesExactCanonicalIdentityAndName(){
        val groups=WatcherLink.parseGroups(feed(WatcherGroups.LEGACY_GROUP,"402796264871862").toString())
        assertEquals(listOf(WatcherGroups.LEGACY_GROUP,"402796264871862"),groups.map{it.id});assertEquals("Łódź",groups[0].name)
        assertEquals(0,WatcherLink.parseGroups(feed().toString()).size)
    }
    @Test fun corruptUnsupportedDuplicateAndCrossGroupFeedFailsBeforeChangingCatalog(){
        val bad=feed(WatcherGroups.LEGACY_GROUP);bad.getJSONArray("groups").getJSONObject(0).put("url","https://www.facebook.com/groups/402796264871862/")
        for(value in listOf(bad,feed("foreign"),feed(WatcherGroups.LEGACY_GROUP,WatcherGroups.LEGACY_GROUP),feed().put("version",2)))assertTrue(runCatching{WatcherLink.parseGroups(value.toString())}.isFailure)
        assertEquals(11,WatcherGroups.active.size)
    }
    @Test fun disablingSelectedSourceStopsAutomationWithoutDeletingHistoricalArchive(){
        PocPolicy.selectGroup(WatcherGroups.LEGACY_GROUP)
        val filename=WatcherGroups.archiveFile(WatcherGroups.LEGACY_GROUP)
        WatcherGroups.setActive(listOf(WatcherGroups.find("402796264871862")!!))
        assertEquals(PageKind.OTHER_GROUP,PocPolicy.classify("https://www.facebook.com/groups/${WatcherGroups.LEGACY_GROUP}/"))
        assertEquals(PageKind.OTHER_GROUP,PocPolicy.classify("https://www.facebook.com/groups/${WatcherGroups.LEGACY_GROUP}/posts/550000000000099/"))
        assertEquals(filename,WatcherGroups.archiveFile(WatcherGroups.LEGACY_GROUP))
        assertTrue(runCatching{PocPolicy.selectGroup(WatcherGroups.LEGACY_GROUP)}.isFailure)
    }
}
