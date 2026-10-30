package pl.jakubokruszek.flipwatcher.geckopoc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PocPolicyTest {
    private val group = PocPolicy.APPROVED_GROUP_ID

    @Test fun `approved group on every Facebook host`() {
        assertEquals(PageKind.APPROVED_GROUP, PocPolicy.classify("https://www.facebook.com/groups/$group/"))
        assertEquals(PageKind.APPROVED_GROUP, PocPolicy.classify("https://m.facebook.com/groups/$group"))
        assertEquals(PageKind.APPROVED_GROUP, PocPolicy.classify("https://facebook.com/groups/$group/?ref=share"))
    }

    @Test fun `verification, login and other groups are recognised`() {
        assertEquals(PageKind.CHECKPOINT, PocPolicy.classify("https://m.facebook.com/checkpoint/1501092823525282/"))
        assertEquals(PageKind.CHECKPOINT, PocPolicy.classify("https://www.facebook.com/two_step_verification/two_factor/"))
        assertEquals(PageKind.CAPTCHA, PocPolicy.classify("https://www.facebook.com/captcha/"))
        assertEquals(PageKind.LOGIN, PocPolicy.classify(PocPolicy.LOGIN_URL))
        assertEquals(PageKind.LOGIN, PocPolicy.classify("https://m.facebook.com/login/device-based/regular/login/"))
        assertEquals(PageKind.OTHER_GROUP, PocPolicy.classify("https://www.facebook.com/groups/123456/"))
        assertEquals(PageKind.OTHER_GROUP, PocPolicy.classify("https://www.facebook.com/groups/$group/members/"))
        assertEquals(PageKind.FACEBOOK_OTHER, PocPolicy.classify("https://m.facebook.com/home.php"))
    }

    @Test fun `non Facebook, plain http and lookalike hosts are blocked`() {
        assertEquals(PageKind.BLOCKED, PocPolicy.classify("https://example.com/groups/$group/"))
        assertEquals(PageKind.BLOCKED, PocPolicy.classify("http://www.facebook.com/groups/$group/"))
        assertEquals(PageKind.BLOCKED, PocPolicy.classify("https://www.facebook.com.evil.example/groups/$group/"))
        assertEquals(PageKind.BLOCKED, PocPolicy.classify("https://evilfacebook.com/"))
        assertFalse(PocPolicy.allowNavigation("https://example.com/"))
        assertTrue(PocPolicy.allowNavigation("https://www.facebook.com/checkpoint/"))
        assertTrue(PocPolicy.allowNavigation("about:blank"))
    }

    @Test fun `loopback is only a fixture in fixture mode`() {
        val url = "http://127.0.0.1:4321/groups/$FIXTURE_GROUP_ID/?fixture=feed-basic"
        assertEquals(PageKind.BLOCKED, PocPolicy.classify(url))
        assertEquals(PageKind.FIXTURE, PocPolicy.classify(url, fixtureMode = true))
        assertFalse(PocPolicy.allowNavigation(url))
    }

    @Test fun `only the approved group or a fixture can be scanned`() {
        PageKind.entries.forEach { kind ->
            assertEquals(kind == PageKind.APPROVED_GROUP || kind == PageKind.FIXTURE, PocPolicy.canScan(kind))
        }
    }

    @Test fun `stop messages for every halt`() {
        assertNotNull(PocPolicy.stopMessage(PageKind.CHECKPOINT, loginRequested = true))
        assertNotNull(PocPolicy.stopMessage(PageKind.CAPTCHA, loginRequested = true))
        assertNotNull(PocPolicy.stopMessage(PageKind.LOGIN, loginRequested = false))
        assertNull(PocPolicy.stopMessage(PageKind.LOGIN, loginRequested = true))
        assertNotNull(PocPolicy.stopMessage(PageKind.OTHER_GROUP, loginRequested = false))
        assertNull(PocPolicy.stopMessage(PageKind.APPROVED_GROUP, loginRequested = false))
    }

    @Test fun `trusted ports come only from the top Facebook frame`() {
        assertTrue(PocPolicy.isTrustedSender("https://m.facebook.com/groups/$group/", isTopLevel = true, fixtureMode = false))
        assertFalse(PocPolicy.isTrustedSender("https://m.facebook.com/groups/$group/", isTopLevel = false, fixtureMode = false))
        assertFalse(PocPolicy.isTrustedSender("https://ads.example/", isTopLevel = true, fixtureMode = false))
        assertFalse(PocPolicy.isTrustedSender("http://127.0.0.1:1/x", isTopLevel = true, fixtureMode = false))
        assertTrue(PocPolicy.isTrustedSender("http://127.0.0.1:1/x", isTopLevel = true, fixtureMode = true))
        assertFalse(PocPolicy.isTrustedSender(null, isTopLevel = true, fixtureMode = true))
    }

    @Test fun `sanitize drops query and fragment that can carry tokens`() {
        assertEquals("https://m.facebook.com/login/", PocPolicy.sanitize("https://m.facebook.com/login/?next=x&access_token=SECRET#frag"))
        assertEquals("http://127.0.0.1:8080/groups/1/", PocPolicy.sanitize("http://127.0.0.1:8080/groups/1/?fixture=a"))
        assertFalse(PocPolicy.sanitize("https://www.facebook.com/?token=abc").contains("abc"))
        assertEquals("—", PocPolicy.sanitize(null))
    }

    @Test fun `login url is the official page returning to the approved group`() {
        assertTrue(PocPolicy.LOGIN_URL.startsWith("https://www.facebook.com/login/?next="))
        assertTrue(PocPolicy.LOGIN_URL.contains(group))
    }

    @Test fun `the separately approved group is an exact slug not an alias of the old numeric group`() {
        assertEquals("lodzsprzedazzakupwynajem", group)
        assertEquals(PageKind.APPROVED_GROUP, PocPolicy.classify("https://www.facebook.com/groups/lodzsprzedazzakupwynajem/"))
        assertEquals(PageKind.OTHER_GROUP, PocPolicy.classify("https://www.facebook.com/groups/402796264871862/"))
        assertEquals(PageKind.OTHER_GROUP, PocPolicy.classify("https://www.facebook.com/groups/1350200629551011/"))
        assertEquals(PageKind.APPROVED_POST, PocPolicy.classify("https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/100000000001/"))
        assertTrue(PocPolicy.VERIFIED_ALIASES.isEmpty())
        assertTrue(PocPolicy.aliasesFor(group).isEmpty())
        assertTrue(ScanRequest(nonce = "n").aliases.isEmpty())
    }

    @Test fun `a verified alias unlocks exactly that slug and nothing else`() {
        val aliases = mapOf("verifiedslug" to group, "othergroupslug" to "999999999")
        assertEquals(PageKind.APPROVED_GROUP, PocPolicy.classify("https://www.facebook.com/groups/verifiedslug/", aliases = aliases))
        assertEquals(PageKind.APPROVED_GROUP, PocPolicy.classify("https://m.facebook.com/groups/verifiedslug", aliases = aliases))
        assertEquals(PageKind.OTHER_GROUP, PocPolicy.classify("https://www.facebook.com/groups/othergroupslug/", aliases = aliases))
        assertEquals(PageKind.OTHER_GROUP, PocPolicy.classify("https://www.facebook.com/groups/verifiedslug2/", aliases = aliases))
        assertEquals(PageKind.OTHER_GROUP, PocPolicy.classify("https://www.facebook.com/groups/verifiedslug/members/", aliases = aliases))
        assertEquals(PageKind.BLOCKED, PocPolicy.classify("https://evil.example/groups/verifiedslug/", aliases = aliases))
        assertEquals(listOf("verifiedslug"), PocPolicy.aliasesFor(group, aliases))
    }

    @Test fun `group segment is exact`() {
        assertEquals("abc", PocPolicy.groupSegment("https://www.facebook.com/groups/abc/"))
        assertEquals(null, PocPolicy.groupSegment("https://www.facebook.com/groups/abc/posts/1/"))
        assertEquals(null, PocPolicy.groupSegment("https://www.facebook.com/home.php"))
    }
    @Test fun exactPostCanBeViewedButNeverGrantsGroupScanning(){
        val url="https://www.facebook.com/groups/$group/posts/100000000001/"
        assertEquals(PageKind.APPROVED_POST,PocPolicy.classify(url))
        assertFalse(PocPolicy.canScan(PageKind.APPROVED_POST))
        assertNull(PocPolicy.stopMessage(PageKind.APPROVED_POST,false))
        for(bad in listOf(url+"?comment_id=123",url+"#comment",url.replace(group,"foreign"),url.replace("www.facebook.com","user@www.facebook.com"),url.replace("www.facebook.com","www.facebook.com:443")))assertFalse(PocPolicy.classify(bad)==PageKind.APPROVED_POST)
    }

}
