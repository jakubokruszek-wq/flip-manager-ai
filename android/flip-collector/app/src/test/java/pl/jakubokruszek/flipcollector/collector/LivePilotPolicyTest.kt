package pl.jakubokruszek.flipcollector.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import pl.jakubokruszek.flipcollector.integration.AtomicAutomationStorage

class LivePilotPolicyTest {
    private val source = LivePilotSource("11111111-1111-4111-8111-111111111111", "test-group", "https://www.facebook.com/groups/test-group/")
    private fun envelope(count: Int = 1): JSONObject {
        val posts = JSONArray()
        repeat(count) { i -> posts.put(JSONObject().put("postId",(1000+i).toString()).put("sourceId",source.sourceId).put("sourceType","GROUP")
            .put("permalink",source.url+"posts/${1000+i}/").put("identityConfidence","EXACT").put("author","Fixture").put("text","Sprzedam mieszkanie 42 m2 Łódź Retkinia 260 tys.").put("media",JSONArray())) }
        return JSONObject().put("version",1).put("nonce","fixture-nonce").put("batch",source.input().put("posts",posts).put("imageMode","SOURCE_SCAN_DATA_ONLY")
            .put("health",JSONObject().put("capturedPostCount",count).put("visibleCardCount",count).put("scrolls",0).put("durationMs",1)))
    }
    @Test fun exactOriginMainFrameAndPageAreAllRequired() {
        assertTrue(LivePilotPolicy.trustedMessage(source.origin,true,source.url,source))
        assertFalse(LivePilotPolicy.trustedMessage(source.origin,false,source.url,source))
        assertFalse(LivePilotPolicy.trustedMessage("https://www.facebook.com.evil.test",true,source.url,source))
        assertFalse(LivePilotPolicy.trustedMessage(source.origin,true,"https://www.facebook.com/groups/another/",source))
        assertFalse(source.matchesPage(source.url+"?redirect=1"))
    }
    @Test fun sourceRejectsProfilesRedirectsCredentialsAndPorts() {
        for (url in listOf("https://www.facebook.com/profile.php?id=test-group", "https://www.facebook.com:444/groups/test-group/", "https://a@www.facebook.com/groups/test-group/", source.url+"posts/1/")) {
            assertThrows(IllegalArgumentException::class.java) { LivePilotSource(source.remoteId,source.sourceId,url) }
        }
    }
    @Test fun twentyPostsPassButTwentyOneDoNot() {
        assertEquals(20,LivePilotPolicy.validate(envelope(20).toString(),"fixture-nonce",source).getJSONArray("posts").length())
        assertThrows(IllegalArgumentException::class.java) { LivePilotPolicy.validate(envelope(21).toString(),"fixture-nonce",source) }
    }
    @Test fun nonceSourceModeAndDuplicatesFailClosed() {
        val wrongNonce=envelope().put("nonce","other")
        val wrongSource=envelope().apply { getJSONObject("batch").put("sourceId","other") }
        val wrongMode=envelope().apply { getJSONObject("batch").put("imageMode","GALLERY_HYDRATION_MEDIA_ALLOWED") }
        val duplicate=envelope(2).apply { val rows=getJSONObject("batch").getJSONArray("posts");rows.put(1,rows.getJSONObject(0)) }
        for (row in listOf(wrongNonce,wrongSource,wrongMode,duplicate)) {
            assertThrows(IllegalArgumentException::class.java) { LivePilotPolicy.validate(row.toString(),"fixture-nonce",source) }
        }
    }
    @Test fun unverifiedPostCannotBorrowMedia() {
        val value=envelope(2)
        value.getJSONObject("batch").getJSONArray("posts").getJSONObject(1).put("identityConfidence","UNVERIFIED").put("media",JSONArray().put(JSONObject()))
        assertThrows(IllegalArgumentException::class.java) { LivePilotPolicy.validate(value.toString(),"fixture-nonce",source) }
    }
    @Test fun mediaNeedsPostBindingAndCdn() {
        for (url in listOf("https://evil.test/photo.jpg","https://x.fbcdn.net:444/photo.jpg","https://a@x.fbcdn.net/photo.jpg")) {
            val value=envelope()
            value.getJSONObject("batch").getJSONArray("posts").getJSONObject(0).getJSONArray("media").put(JSONObject().put("url",url).put("exactPostId","1000").put("exactAssociation",true))
            assertThrows(IllegalArgumentException::class.java) { LivePilotPolicy.validate(value.toString(),"fixture-nonce",source) }
        }
    }
    @Test fun oversizeAndStopAreRejected() {
        assertThrows(IllegalArgumentException::class.java) { LivePilotPolicy.validate("x".repeat(LivePilotPolicy.MAX_PAYLOAD_BYTES+1),"fixture-nonce",source) }
        assertThrows(IllegalStateException::class.java) { LivePilotPolicy.validate(JSONObject().put("version",1).put("nonce","fixture-nonce").put("stop","CAPTCHA").toString(),"fixture-nonce",source) }
    }
    private class Disk : AtomicAutomationStorage { var bytes: String?=null;override fun read()=bytes;override fun write(value:String){bytes=value} }
    @Test fun journalSurvivesRestartAndReceiptReplayWithoutDuplicateHistory() {
        val disk=Disk();val first=LivePilotJournal(disk)
        val job=ClaimedJob("job","SECRET_LEASE","run","SOURCE_SCAN",JSONObject())
        first.claimed(job)
        val pending=PendingCompletion("SECRET_DEVICE","job","SECRET_LEASE","completion","SECRET_POST_TEXT")
        first.save(pending)
        val recovered=LivePilotJournal(disk)
        assertEquals(pending,recovered.load())
        val receipt=JSONObject().put("ok",true).put("completionId","completion").put("status","completed")
        recovered.acknowledge(pending,receipt)
        // Simulate a process crash after receipt commit but before outbox clear.
        LivePilotJournal(disk).acknowledge(pending,receipt)
        assertEquals(1,recovered.diagnostics().getInt("receipts"))
        assertEquals(pending,recovered.load())
        val exported=recovered.diagnostics().toString()
        assertFalse(exported.contains("SECRET"))
        recovered.save(null)
        assertNull(recovered.load())
    }
    @Test fun journalNeverReconfiguresOverPendingOrOfflineData() {
        val disk=Disk();val state=LivePilotJournal(disk)
        state.claimed(ClaimedJob("job","lease","run","SOURCE_SCAN",JSONObject()))
        assertThrows(IllegalStateException::class.java) { state.configure("new profile") }
        disk.bytes="{\"mode\":\"OFFLINE_TEST\"}"
        assertThrows(IllegalStateException::class.java) { state.diagnostics() }
    }
}
