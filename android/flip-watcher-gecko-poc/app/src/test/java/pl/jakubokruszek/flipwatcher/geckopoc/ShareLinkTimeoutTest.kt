package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ShareLinkTimeoutTest {
    private val share="https://www.facebook.com/share/p/syntheticToken01/"
    @Test fun eachLastUnmetConditionHasItsOwnBoundedPrivateTerminalReason() {
        for(condition in ShareLinkWait.values()) {
            var clock=0L;val g=ShareLinkResolver(now={clock});assertTrue(g.begin(share,true));g.request(share,false)
            g.waitingFor(condition);clock=19_999;assertTrue(g.tick());clock=20_000;assertFalse(g.tick())
            assertEquals(condition.code,g.reason);assertEquals(ShareLinkResolver.Status.TIMEOUT,g.status)
            val result=ShareLinkResult.snapshot(g)!!;assertEquals(0,result.confirmedIds)
            assertEquals(result.report(),ShareLinkResult.decode(result.encode())!!.report())
            assertEquals(setOf("status","reason","requests","confirmedIds"),JSONObject(result.encode()).keys().asSequence().toSet())
            assertFalse(result.report().contains("syntheticToken"));assertFalse(result.encode().contains("https:"))
        }
    }
    @Test fun lastObservationReplacesEarlierWaitWithoutExtendingDeadline() {
        var clock=0L;val g=ShareLinkResolver(now={clock});g.begin(share,true)
        g.waitingFor(ShareLinkWait.PORT);clock=19_999;g.waitingFor(ShareLinkWait.DOCUMENT_FRESHNESS)
        clock=20_000;assertFalse(g.tick());assertEquals("DEADLINE_DOCUMENT_FRESHNESS",g.reason)
    }
    @Test fun blockedConditionNeverBecomesConfirmationOrRestoredConsent() {
        var clock=0L;val g=ShareLinkResolver(now={clock});g.begin(share,true);g.request(share,false);g.location(share)
        assertFalse(g.hasExactPostAddress);assertFalse(g.confirm(share,true,true));g.waitingFor(ShareLinkWait.EXACT_PERMALINK)
        clock=20_000;g.tick();assertFalse(g.confirm(share,true,true));assertFalse(g.begin(share,true))
        assertEquals("DEADLINE_EXACT_PERMALINK",g.reason)
    }
    @Test fun safetyStopWinsAndLaterObservationsCannotOverwriteTerminalStatus() {
        var clock=0L;val g=ShareLinkResolver(now={clock});g.begin(share,true);g.waitingFor(ShareLinkWait.PORT)
        g.stop("PAUSED");g.waitingFor(ShareLinkWait.EXACT_PERMALINK);clock=30_000;g.tick();assertEquals("PAUSED",g.reason)
    }
    @Test fun legacyDeadlineIsReadableButTimeoutReasonCannotClaimStopOrConfirmation() {
        assertNotNull(ShareLinkResult.decode("""{"status":"TIMEOUT","reason":"DEADLINE","requests":2,"confirmedIds":0}"""))
        for(condition in ShareLinkWait.values()) for(status in listOf("STOP","CONFIRMED")) {
            assertNull(ShareLinkResult.decode(JSONObject().put("status",status).put("reason",condition.code).put("requests",2).put("confirmedIds",if(status=="CONFIRMED")1 else 0).toString()))
        }
        assertNull(ShareLinkResult.decode("""{"status":"TIMEOUT","reason":"DEADLINE_PRIVATE_URL","requests":2,"confirmedIds":0}"""))
    }
}
