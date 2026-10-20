package pl.jakubokruszek.flipwatcher.geckopoc

import org.junit.Assert.*
import org.junit.Test

class ShareLinkResolverTest {
    private val share = "https://www.facebook.com/share/p/1CQAWJHP9L/"
    private val post = "https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/123456789/"
    private var clock = 0L
    private fun gate() = ShareLinkResolver(now = { clock })
    private fun armed() = gate().also { assertTrue(it.begin(share, true)); assertTrue(it.request(share, false)); assertTrue(it.location(share)) }
    @Test fun absentConsentNeverStarts() { val g=gate(); assertFalse(g.begin(share,false)); assertFalse(g.request(share,false)); assertEquals(0,g.requests) }
    @Test fun inputMustBeOneExactShareLink() { for(u in listOf(post,"http://www.facebook.com/share/p/1CQAWJHP9L/", "$share?token=private", "$share#private", "https://www.facebook.com.evil/share/p/1CQAWJHP9L/", "https://user@www.facebook.com/share/p/1CQAWJHP9L/", "https://www.facebook.com:443/share/p/1CQAWJHP9L/", "https://www.facebook.com/share/r/1CQAWJHP9L/")) assertFalse(u,gate().begin(u,true)) }
    @Test fun shareTokenNeverBecomesPostId() { val g=armed();assertFalse(g.confirm(share,true,true));assertEquals(ShareLinkResolver.Status.ACTIVE,g.status);assertTrue(g.report().contains("grupy: 0"));assertFalse(g.report().contains("1CQAW")) }
    @Test fun onlyFinalSafeCompleteDocumentConfirms() { val g=armed();assertTrue(g.request(post,true));assertTrue(g.location(post));assertFalse(g.confirm(post,true,false));assertTrue(g.confirm(post,true,true));assertEquals(ShareLinkResolver.Status.CONFIRMED,g.status);assertTrue(g.report().contains("grupy: 1"));assertFalse(g.report().contains("123456789"));assertFalse(g.report().contains("https:")) }
    @Test fun unrelatedContextCannotConfirm() { val g=armed();assertFalse(g.confirm(post,true,true));assertEquals(ShareLinkResolver.Status.ACTIVE,g.status) }
    @Test fun numericalGroupAliasRemainsUnverified() { val g=armed();assertFalse(g.request(post.replace(PocPolicy.APPROVED_GROUP_ID,"402796264871862"),true));assertEquals("UNVERIFIED_DESTINATION",g.reason) }
    @Test fun foreignAndPhotoAndProfileLinksStop() { for(u in listOf(post.replace(PocPolicy.APPROVED_GROUP_ID,"other"),"https://www.facebook.com/photo/?fbid=123456789","https://www.facebook.com/profile/posts/123456789/","https://evil.test/")) {val g=armed();assertFalse(g.request(u,true));assertEquals(ShareLinkResolver.Status.STOP,g.status)} }
    @Test fun loginAndCheckpointAndCaptchaStopBeforeLoading() {for(p in listOf("login/","checkpoint/","captcha/","two_step_verification/")){val g=armed();assertFalse(g.request("https://www.facebook.com/$p",true));assertEquals("VERIFICATION_OR_LOGIN",g.reason)}}
    @Test fun unsafeDomStopsWithoutResult() {val g=armed();g.request(post,true);g.location(post);assertFalse(g.confirm(post,false,true));assertEquals("UNSAFE_DOCUMENT",g.reason)}
    @Test fun gestureAndNewWindowAndNonRedirectStop() { for(mode in 0..2){val g=armed();assertFalse(g.request(post, mode!=0, newWindow=mode==1,gesture=mode==2));assertEquals("UNEXPECTED_NAVIGATION",g.reason)} }
    @Test fun redirectLoopBoundedToEightRequests() {val g=armed();repeat(7){assertTrue(g.request(share,true))};assertFalse(g.request(share,true));assertEquals(8,g.requests);assertEquals("REDIRECT_LIMIT",g.reason)}
    @Test fun timeoutCannotBeExtendedByNavigation() {val g=armed();clock=19_999;assertTrue(g.request(post,true));g.location(post);clock=20_000;assertFalse(g.confirm(post,true,true));assertEquals(ShareLinkResolver.Status.TIMEOUT,g.status)}
    @Test fun cancellationRejectsAllLateCallbacks() {val g=armed();g.stop("PAUSED");assertFalse(g.location(post));assertFalse(g.confirm(post,true,true));assertFalse(g.request(post,true));assertEquals(ShareLinkResolver.Status.STOP,g.status)}
    @Test fun everyAttemptNeedsNewObjectAndConsent() {val old=armed();old.stop();assertFalse(old.begin(share,true));val fresh=gate();assertFalse(fresh.begin(share,false));assertEquals(0,fresh.requests)}
    @Test fun portLossOnlyAllowedDuringExpectedDocumentTransition() {val g=armed();g.disconnected();assertTrue(g.active);g.confirm(share,true,false);g.disconnected();assertEquals("PORT_LOST",g.reason)}
    @Test fun changedLocationAndNonDigitIdStop() {for(u in listOf(post+"?comment_id=123",post.replace("123456789","FAKE"),share.replace("1CQAWJHP9L","otherShare"))){val g=armed();assertFalse(g.location(u));assertEquals("CONTEXT_CHANGED",g.reason)}}
    @Test fun loopbackOnlyWithExplicitFixtureOriginAndPort() {val g=ShareLinkResolver("1234567890123", {clock},"http://127.0.0.1:9876");assertTrue(g.begin("http://127.0.0.1:9876/share/p/fixture1/",true));assertFalse(g.request("http://127.0.0.1:9877/share/p/fixture1/",false))}
}
