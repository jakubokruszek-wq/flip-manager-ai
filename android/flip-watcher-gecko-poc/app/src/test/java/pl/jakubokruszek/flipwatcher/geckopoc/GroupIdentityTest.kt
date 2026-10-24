package pl.jakubokruszek.flipwatcher.geckopoc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GroupIdentityTest {
    /** Hypothetical numeric-source evidence tests are independent of the active slug-only POC. */
    private val approved = "402796264871862"
    private val slug = "lodzsprzedazzakupwynajem"
    private val numericUrl = "https://www.facebook.com/groups/$approved/"
    private val slugUrl = "https://www.facebook.com/groups/$slug/"
    private val strong = listOf(GroupIdHit(approved, "al:android:url"))

    @Test fun `directly approved slug reports its own identity without numeric alias inference`() {
        val source = PocPolicy.APPROVED_GROUP_ID
        assertEquals(GroupVerdict.APPROVED_SOURCE, GroupIdentity.assess(source, source, emptyList(), emptyList()).verdict)
        assertEquals(GroupVerdict.INSUFFICIENT, GroupIdentity.assess(source, approved, emptyList(), emptyList()).verdict)
    }

    @Test fun `numeric address is the approved group`() {
        assertEquals(GroupVerdict.APPROVED_NUMERIC, GroupIdentity.assess(approved, approved, emptyList(), emptyList()).verdict)
    }

    @Test fun `same group needs both Facebook metadata and a redirect without a click`() {
        val trace = listOf(NavStep(numericUrl, false, false), NavStep(slugUrl, true, false))
        assertEquals(GroupVerdict.SAME_GROUP_EVIDENCE, GroupIdentity.assess(approved, slug, strong, trace).verdict)
        // In-page address change by Facebook (history API) without a click also counts.
        val history = listOf(NavStep(numericUrl, false, false), NavStep(numericUrl, false, false, viaHistory = true), NavStep(slugUrl, false, false, viaHistory = true))
        assertEquals(GroupVerdict.SAME_GROUP_EVIDENCE, GroupIdentity.assess(approved, slug, strong, history).verdict)
    }

    @Test fun `metadata alone, redirect alone, or weak JSON ids are not enough`() {
        val trace = listOf(NavStep(numericUrl, false, false), NavStep(slugUrl, true, false))
        assertEquals(GroupVerdict.INSUFFICIENT, GroupIdentity.assess(approved, slug, strong, emptyList()).verdict)
        assertEquals(GroupVerdict.INSUFFICIENT, GroupIdentity.assess(approved, slug, emptyList(), trace).verdict)
        assertEquals(GroupVerdict.INSUFFICIENT, GroupIdentity.assess(approved, slug, listOf(GroupIdHit(approved, "json×5")), trace).verdict)
    }

    @Test fun `a click or a fresh load elsewhere breaks the redirect chain`() {
        assertFalse(GroupIdentity.serverRedirected(approved, slug, listOf(NavStep(numericUrl, false, false), NavStep(slugUrl, false, true))))
        assertFalse(GroupIdentity.serverRedirected(approved, slug, listOf(NavStep(numericUrl, false, false), NavStep("https://www.facebook.com/", false, false), NavStep(slugUrl, true, false))))
        assertFalse(GroupIdentity.serverRedirected(approved, slug, listOf(NavStep(slugUrl, true, false))))
        assertTrue(GroupIdentity.serverRedirected(approved, slug, listOf(NavStep(numericUrl, false, false), NavStep(slugUrl, true, false))))
    }

    @Test fun `metadata naming another group means a different group`() {
        val trace = listOf(NavStep(numericUrl, false, false), NavStep(slugUrl, true, false))
        val other = listOf(GroupIdHit("1350200629551011", "al:android:url"))
        assertEquals(GroupVerdict.DIFFERENT_GROUP, GroupIdentity.assess(approved, slug, other, trace).verdict)
        val mixed = strong + GroupIdHit("1350200629551011", "al:ios:url")
        assertEquals(GroupVerdict.INSUFFICIENT, GroupIdentity.assess(approved, slug, mixed, trace).verdict)
    }

    @Test fun `the description never claims the scan is unlocked`() {
        val text = GroupIdentity.describe(GroupIdentity.assess(approved, slug, strong, listOf(NavStep(numericUrl, false, false), NavStep(slugUrl, true, false))))
        assertTrue(text.contains("DOWÓD ALIASU"))
        assertTrue(text.contains("zablokowany"))
    }
}
