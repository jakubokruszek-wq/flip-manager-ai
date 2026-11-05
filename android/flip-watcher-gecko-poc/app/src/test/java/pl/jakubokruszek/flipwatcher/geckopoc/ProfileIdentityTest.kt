package pl.jakubokruszek.flipwatcher.geckopoc
import org.junit.Assert.*
import org.junit.Test
class ProfileIdentityTest {
    private val source=WatcherGroup("61563667387467","Dawid","PROFILE")
    @Test fun opaqueIdsAreProfileOnlyAndCandidateUrlsAreNotGroupGrants(){
        assertFalse(ProfileIdentity.postId("pfbidAbCdEf0123456789"));assertTrue(ProfileIdentity.postId("pfbidAbCdEf0123456789",true))
        assertTrue(ProfileIdentity.candidate(source.url,source));assertTrue(ProfileIdentity.candidate("https://www.facebook.com/dawid.test/",source))
        for(url in listOf("https://www.facebook.com/groups/61563667387467/","https://www.facebook.com/profile.php?id=100008036582269","https://evil.test/61563667387467/","https://www.facebook.com:443/61563667387467/","https://www.facebook.com/61563667387467/#foreign"))assertFalse(url,ProfileIdentity.candidate(url,source))
    }
    @Test fun mixedFeedSeparatesProfilesFromManualGroupCatalog(){
        val profile=org.json.JSONObject().put("sourceId",source.id).put("sourceType","PROFILE").put("name",source.name).put("url",source.url)
        val group=org.json.JSONObject().put("sourceId",WatcherGroups.LEGACY_GROUP).put("sourceType","GROUP").put("name","Grupa").put("url","https://www.facebook.com/groups/${WatcherGroups.LEGACY_GROUP}/")
        fun feed(vararg rows:org.json.JSONObject)=org.json.JSONObject().put("version",2).put("sources",org.json.JSONArray(rows.toList())).toString()
        val sources=WatcherLink.parseSources(feed(group,profile));assertEquals(2,sources.size);assertEquals("profile:${source.id}",sources[1].key)
        assertTrue(runCatching{WatcherLink.parseSources(feed(profile,profile))}.isFailure)
        assertTrue(runCatching{WatcherLink.parseSources(feed(org.json.JSONObject(profile.toString()).put("url","https://www.facebook.com/groups/${source.id}/")))}.isFailure)
    }
}
