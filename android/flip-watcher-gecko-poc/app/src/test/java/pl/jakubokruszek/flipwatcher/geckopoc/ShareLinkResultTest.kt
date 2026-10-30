package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ShareLinkResultTest {
    private fun json(status: String = "STOP", reason: String = "PAUSED", requests: Int = 2, ids: Int = 0) = JSONObject().put("status",status).put("reason",reason).put("requests",requests).put("confirmedIds",ids)
    @Test fun terminalResultRoundTripsOnlyItsFourSafeFields() {
        val j=json();val result=ShareLinkResult.decode(j.toString())!!
        assertEquals(setOf("status","reason","requests","confirmedIds"),JSONObject(result.encode()).keys().asSequence().toSet())
        assertEquals(result.report(),ShareLinkResult.decode(result.encode())!!.report())
        assertTrue(result.report().contains("PAUSED"));assertFalse(result.encode().contains("http"));assertFalse(result.report().contains("/groups/"))
    }
    @Test fun rawDataCannotBeSmuggledThroughReasonOrAdditionalFields() {
        for(key in listOf("url","postId","text","cookie","token","consent","nonce"))assertNull(ShareLinkResult.decode(json().put(key,"PRIVATE").toString()))
        for(reason in listOf("https://www.facebook.com/share/p/private/","123456789012345","PRIVATE_POST_TEXT"))assertNull(ShareLinkResult.decode(json(reason=reason).toString()))
    }
    @Test fun activeOrIdleStateCannotRestoreAnAttemptOrConsent() {for(status in listOf("ACTIVE","IDLE"))assertNull(ShareLinkResult.decode(json(status=status).toString()));val r=ShareLinkResolver(now={0L});assertNull(ShareLinkResult.snapshot(r));r.begin("https://www.facebook.com/share/p/syntheticToken01/",true);assertNull(ShareLinkResult.snapshot(r))}
    @Test fun malformedNumericAndStatusCombinationsAreRejected() {
        for(value in listOf(-1,9,true,"2",2.5))assertNull(ShareLinkResult.decode(json().put("requests",value).toString()))
        assertNull(ShareLinkResult.decode(json(ids=1).toString()));assertNull(ShareLinkResult.decode(json(status="CONFIRMED",reason="PAUSED",ids=1).toString()))
        assertNull(ShareLinkResult.decode(json(reason="DEADLINE").toString()));assertNull(ShareLinkResult.decode(json(status="TIMEOUT").toString()))
    }
    @Test fun confirmedRecordContainsOnlyCountAndFixedReason() {val r=ShareLinkResult.decode(json("CONFIRMED","EXACT_APPROVED_GROUP_LINK",2,1).toString())!!;assertEquals(1,r.confirmedIds);assertTrue(r.report().contains("grupy: 1"));assertNull(ShareLinkResult.decode(json("CONFIRMED","EXACT_APPROVED_GROUP_LINK",0,1).toString()))}
    @Test fun truncatedOversizeAndMissingRecordsFailClosed() {for(s in listOf(null,"", "{", "{}", " ".repeat(513)))assertNull(ShareLinkResult.decode(s))}
    @Test fun pausedAndCancelledSnapshotsDoNotRetainInput() {
        val g=ShareLinkResolver(now={0L});g.begin("https://www.facebook.com/share/p/syntheticToken01/",true);g.stop("PAUSED")
        val r=ShareLinkResult.snapshot(g)!!;assertEquals("PAUSED",r.reason);assertFalse(r.encode().contains("synthetic"));assertFalse(r.report().contains("synthetic"))
        assertEquals("PAUSED",ShareLinkResult.decode(r.encode())!!.reason)
    }
}
