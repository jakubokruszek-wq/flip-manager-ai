package pl.jakubokruszek.flipwatcher.geckopoc

import org.junit.Assert.*
import org.junit.Test

class ShareAddressReloadTest {
    private val share="https://www.facebook.com/share/p/syntheticToken01/"
    private val post="https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/123456789/"
    private var clock=0L
    private fun armed()=ShareLinkResolver(now={clock},allowAddressReload=true).also { assertTrue(it.begin(share,true));assertTrue(it.request(share,false));assertTrue(it.location(share)) }
    @Test fun changedAddressIsOnlyCandidateUntilFreshNativeRequestAndContext() {
        val g=armed();assertTrue(g.location(post));assertEquals(post,g.pendingAddressReload)
        assertEquals(1,g.requests);assertFalse(g.canInspect(post));assertFalse(g.confirm(post,true,true))
        assertTrue(g.claimAddressReload(post));assertNull(g.pendingAddressReload);assertFalse(g.claimAddressReload(post))
        assertTrue(g.request(post,false));assertEquals(2,g.requests)
        assertFalse(g.confirm(post,true,true));assertTrue(g.location(post));assertTrue(g.canInspect(post))
        assertFalse(g.confirm(post,true,false));assertTrue(g.confirm(post,true,true))
        assertEquals("EXACT_APPROVED_ADDRESS_RELOADED",g.reason)
        val saved=ShareLinkResult.snapshot(g)!!;assertEquals(1,saved.confirmedIds)
        assertNotNull(ShareLinkResult.decode(saved.encode()));assertFalse(saved.encode().contains("123456789"))
        assertTrue(saved.report().contains("Nie potwierdzono powiązania"));assertNull(g.pendingAddressReload)
    }
    @Test fun unchangedStrictModeStillRejectsAddressWithoutRequest() {
        val g=ShareLinkResolver(now={clock});g.begin(share,true);g.request(share,false)
        assertFalse(g.location(post));assertEquals("LOCATION_WITHOUT_REQUEST",g.reason)
    }
    @Test fun candidateCannotAuthorizePageRequestBeforeNativeClaim() {
        val g=armed();g.location(post);assertFalse(g.request(post,false));assertEquals("RELOAD_INTERRUPTED",g.reason)
    }
    @Test fun duplicateLocationDoesNotIssueAnotherReloadButDifferentLocationStops() {
        val g=armed();g.location(post);assertTrue(g.location(post));assertTrue(g.claimAddressReload(post))
        assertTrue(g.location(post));assertFalse(g.claimAddressReload(post));assertFalse(g.location(share))
        assertEquals("RELOAD_INTERRUPTED",g.reason)
    }
    @Test fun gestureNewWindowAndWrongRequestCannotConsumeClaim() {
        val click=armed();assertFalse(click.location(post,true));assertEquals("UNEXPECTED_NAVIGATION",click.reason)
        for(mode in 0..3) {
            val g=armed();g.location(post);g.claimAddressReload(post)
            assertFalse(g.request(if(mode==0)share else post,redirect=mode==1,newWindow=mode==2,gesture=mode==3))
            assertEquals(ShareLinkResolver.Status.STOP,g.status)
        }
    }
    @Test fun foreignAliasQueryAndFakeIdNeverQueueARequest() {
        for(u in listOf(post.replace(PocPolicy.APPROVED_GROUP_ID,"other"),post.replace(PocPolicy.APPROVED_GROUP_ID,"402796264871862"),post+"?token=private",post.replace("123456789","FAKE"),post.replace("www.facebook.com","evil.test"))) {
            val g=armed();assertFalse(g.location(u));assertNull(g.pendingAddressReload);assertEquals("LOCATION_UNVERIFIED",g.reason)
        }
    }
    @Test fun secondUnrequestedChangeStopsInsteadOfLooping() {
        val g=armed();g.location(post);g.claimAddressReload(post);g.request(post,false);g.location(post)
        assertFalse(g.location(post.replace("123456789","987654321")));assertEquals("RELOAD_LIMIT",g.reason)
    }
    @Test fun reloadSharesOriginalDeadlineAndCannotResumeAfterPause() {
        val g=armed();clock=19_999;g.location(post);clock=20_000
        assertFalse(g.claimAddressReload(post));assertEquals(ShareLinkResolver.Status.TIMEOUT,g.status);assertNull(g.pendingAddressReload)
        clock=0;val paused=armed();paused.location(post);paused.stop("PAUSED")
        assertNull(paused.pendingAddressReload);assertFalse(paused.claimAddressReload(post));assertFalse(paused.request(post,false));assertEquals("PAUSED",paused.reason)
    }
    @Test fun nativeReloadConsumesSameEightRequestBudget() {
        val g=armed();repeat(6){assertTrue(g.request(share,true))};g.location(share)
        assertTrue(g.location(post));assertTrue(g.claimAddressReload(post));assertTrue(g.request(post,false));assertEquals(8,g.requests)
        assertFalse(g.request(post,true));assertEquals("REDIRECT_LIMIT",g.reason)
        val full=armed();repeat(7){full.request(share,true)};assertFalse(full.location(post));assertEquals("REDIRECT_LIMIT",full.reason)
    }
    @Test fun sameShareCanonicalizationDoesNotTurnTokenIntoId() {
        val canonical=share.replace("www.facebook.com","m.facebook.com").trimEnd('/')
        val g=armed();g.location(canonical);g.claimAddressReload(canonical);assertTrue(g.request(canonical,false));assertTrue(g.location(canonical))
        assertFalse(g.confirm(canonical,true,true));assertEquals(ShareLinkResolver.Status.ACTIVE,g.status)
        assertTrue(g.request(post,true));assertTrue(g.location(post));assertTrue(g.confirm(post,true,true))
        assertEquals("EXACT_APPROVED_ADDRESS_RELOADED",g.reason)
    }
    @Test fun reloadedReportCannotClaimConfirmationWithOnlyOneRequest() {
        assertNull(ShareLinkResult.decode("""{"status":"CONFIRMED","reason":"EXACT_APPROVED_ADDRESS_RELOADED","requests":1,"confirmedIds":1}"""))
    }
}
