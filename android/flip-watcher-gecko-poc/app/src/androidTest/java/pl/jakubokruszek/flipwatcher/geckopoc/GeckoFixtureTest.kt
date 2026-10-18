package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import android.util.Log
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoSessionSettings
import java.util.UUID

/**
 * Real GeckoView on the emulator, LOCAL fixture pages only (served on
 * 127.0.0.1). No test opens Facebook or any account.
 */
@RunWith(AndroidJUnit4::class)
class GeckoFixtureTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val scanner = HeadlessFixtureScan(context)
    private val groupPath = "/groups/$FIXTURE_GROUP_ID/"

    private fun scan(path: String, fixture: String, scrolls: Int = 0) = runBlocking { withTimeout(120_000) { scanner.run(path, fixture, scrolls, scrollPauseMs = 800) } }

    private fun expectedId(n: Int) = (500_000_000_000_000L + n).toString()

    @Test fun builtInExtensionInstallsAndConnects() {
        val result = scan(groupPath, "feed-basic")
        assertTrue("extension port did not connect", result.portConnected)
    }

    @Test fun userAgentIsNormalFirefoxNotWebView() {
        val ua = scan(groupPath, "other").userAgent.orEmpty()
        Log.i("GeckoPocTest", "UA=$ua")
        assertTrue(ua, ua.contains("Firefox/") && ua.contains("Gecko/"))
        assertFalse(ua, ua.contains("; wv"))
        assertFalse(ua, ua.contains("Chrome/"))
    }

    @Test fun readsExactIdsWithoutDuplicates() {
        val report = scan(groupPath, "feed-basic").report
        assertEquals(ScanStatus.OK, report.status)
        assertEquals((1..10).map(::expectedId).toSet(), report.posts.map { it.postId }.toSet())
        assertEquals(report.posts.size, report.posts.map { it.postId }.toSet().size)
        report.posts.forEach { assertEquals(ScanProtocol.canonicalPermalink(FIXTURE_GROUP_ID, it.postId), it.permalink) }
        assertEquals(0, report.rejectedByApp)
        assertEquals(1, report.diagnostics["ambiguousCards"])
        assertEquals(1, report.diagnostics["foreignCards"])
        assertEquals(1, report.diagnostics["cardsWithoutId"])
        // Post ...010 arrives twice: page script and the page's own HTML seen by the network layer.
        assertEquals(2, report.diagnostics["duplicatesDropped"])
    }

    @Test fun capsAtTwentyPosts() {
        val report = scan(groupPath, "feed-many").report
        assertEquals(ScanStatus.OK, report.status)
        assertEquals(20, report.posts.size)
        assertEquals(10, report.diagnostics["overLimitDropped"])
    }

    @Test fun stopsOnCheckpointCaptchaLoginLostAccessAndWrongGroup() {
        assertEquals(ScanStatus.CHECKPOINT, scan("/checkpoint/", "checkpoint").report.status)
        assertEquals(ScanStatus.LOGIN_REQUIRED, scan("/login/", "login").report.status)
        assertEquals(ScanStatus.CAPTCHA, scan(groupPath, "captcha").report.status)
        assertEquals(ScanStatus.GROUP_UNAVAILABLE, scan(groupPath, "unavailable").report.status)
        val wrong = scan("/groups/999/", "feed-basic").report
        assertEquals(ScanStatus.WRONG_GROUP, wrong.status)
        assertTrue(wrong.posts.isEmpty())
    }

    @Test fun lazyFeedLoadsMoreInAVisibleView() {
        // Control: proves the fixture and the scroll logic work when the page is on screen.
        ActivityScenario.launch(GeckoTestHostActivity::class.java).use { scenario ->
            var host: GeckoTestHostActivity? = null
            scenario.onActivity { host = it }
            val report = runBlocking {
                withTimeout(120_000) {
                    scanner.run(groupPath, "lazy-feed", scrolls = 4, scrollPauseMs = 800,
                        attach = { session -> host!!.geckoView.setSession(session) },
                        detach = { host!!.geckoView.releaseSession() })
                }
            }.report
            Log.i("GeckoPocTest", "LAZY_FEED_VISIBLE status=${report.status} posts=${report.posts.size} scrolls=${report.scrolls}")
            assertEquals(ScanStatus.OK, report.status)
            assertTrue("visible view loaded only ${report.posts.size}", report.posts.size >= 10)
        }
    }

    @Test fun lazyFeedWithoutAnySurfaceIsMeasured() {
        // Not an assertion on lazy loading: records whether a session with no
        // surface keeps loading the feed (the stage C question) for the report.
        val report = scan(groupPath, "lazy-feed", scrolls = 4).report
        Log.i("GeckoPocTest", "LAZY_FEED_HEADLESS status=${report.status} posts=${report.posts.size} scrolls=${report.scrolls}")
        assertEquals(ScanStatus.OK, report.status)
        assertTrue(report.posts.size >= 5)
    }

    @Test fun lazyFeedWithOffscreenSurfaceIsMeasured() {
        val report = runBlocking { withTimeout(120_000) { scanner.run(groupPath, "lazy-feed", scrolls = 4, scrollPauseMs = 800, surface = SurfaceMode.OFFSCREEN) } }.report
        Log.i("GeckoPocTest", "LAZY_FEED_OFFSCREEN status=${report.status} posts=${report.posts.size} scrolls=${report.scrolls}")
        assertEquals(ScanStatus.OK, report.status)
        assertTrue(report.posts.size >= 5)
    }

    @Test fun aliasPageIsStoppedWithoutAVerifiedAlias() {
        val report = runBlocking { withTimeout(120_000) { scanner.run("/groups/fixturegroupalias/", "feed-alias") } }.report
        assertEquals(ScanStatus.WRONG_GROUP, report.status)
        assertTrue(report.posts.isEmpty())
    }

    @Test fun verifiedAliasReadsOnlyThisGroupWithNumericIdentity() {
        val report = runBlocking { withTimeout(120_000) { scanner.run("/groups/fixturegroupalias/", "feed-alias", aliases = listOf("fixturegroupalias")) } }.report
        assertEquals(ScanStatus.OK, report.status)
        val ids = (1..5).filter { it != 4 }.map { (540_000_000_000_000L + it).toString() }.toSet()
        assertEquals(ids, report.posts.map { it.postId }.toSet())
        report.posts.forEach { assertEquals(ScanProtocol.canonicalPermalink(FIXTURE_GROUP_ID, it.postId), it.permalink) }
        assertEquals(2, report.diagnostics["foreignCards"])
        assertEquals(1, report.diagnostics["ambiguousCards"])
        assertEquals(0, report.rejectedByApp)
    }

    @Test fun groupProbeReportsFacebookMetadataIds() = runBlocking {
        withTimeout(120_000) {
            withContext(Dispatchers.Main) {
                val server = LoopbackFixtureServer { name -> runCatching { context.assets.open(name).bufferedReader().use { it.readText() } }.getOrNull() }
                val session = GeckoSession(GeckoSessionSettings.Builder().build())
                val channel = CollectorChannel(session, fixtureMode = true)
                try {
                    channel.attach(GeckoHost.collectorExtension(context))
                    session.open(GeckoHost.runtime(context))
                    session.setActive(true)
                    session.loadUri(server.url("/groups/fixturegroupalias/", "feed-alias"))
                    assertTrue(channel.awaitPort(30_000))
                    val (segment, hits) = channel.groupProbe()!!
                    assertEquals("fixturegroupalias", segment)
                    assertEquals(listOf(FIXTURE_GROUP_ID), hits.filter { it.strong }.map { it.id }.distinct())
                } finally {
                    channel.close(); session.close(); server.close()
                }
            }
        }
    }

    /** Opens a local fixture in a real GeckoSession with the extension and runs [block] on its channel. */
    private fun <T> withFixture(path: String, fixture: String, settleMs: Long = 1_500, block: suspend (FixturePage) -> T): T = runBlocking {
        withTimeout(120_000) {
            withContext(Dispatchers.Main) {
                val server = LoopbackFixtureServer { name -> runCatching { context.assets.open(name).bufferedReader().use { it.readText() } }.getOrNull() }
                val session = GeckoSession(GeckoSessionSettings.Builder().build())
                val channel = CollectorChannel(session, fixtureMode = true)
                try {
                    channel.attach(GeckoHost.collectorExtension(context))
                    session.open(GeckoHost.runtime(context))
                    session.setActive(true)
                    session.loadUri(server.url(path, fixture))
                    assertTrue("extension port", channel.awaitPort(30_000))
                    delay(settleMs) // lets the page's own XHR (network layer) finish
                    block(FixturePage(channel, session, server))
                } finally {
                    channel.close(); session.close(); server.close()
                }
            }
        }
    }

    private class FixturePage(val channel: CollectorChannel, val session: GeckoSession, val server: LoopbackFixtureServer)

    private fun scanRequest() = ScanRequest(nonce = UUID.randomUUID().toString(), groupId = FIXTURE_GROUP_ID, allowLoopback = true)

    @Test fun divOnlyMobileFeedYieldsExactIdsFromPageDataAndNetwork() {
        val report = withFixture(groupPath, "mobile-div-feed") { it.channel.scan(scanRequest()) }
        Log.i("GeckoPocTest", "MOBILE_DIV_FEED status=${report.status} posts=${report.posts.map { "${it.postId}:${it.idSource}" }} diag=${report.diagnostics}")
        assertEquals(ScanStatus.OK, report.status)
        assertEquals(setOf("550000000000001", "550000000000002", "550000000000003", "550000000000004"), report.posts.map { it.postId }.toSet())
        assertEquals(setOf("STRUCTURED", "NETWORK"), report.posts.map { it.idSource }.toSet())
        report.posts.forEach { assertEquals(ScanProtocol.canonicalPermalink(FIXTURE_GROUP_ID, it.postId), it.permalink) }
        assertEquals(0, report.rejectedByApp)
    }

    @Test fun structureDiagnosisFindsExactIdsOnDivOnlyFeed() {
        val d = withFixture(groupPath, "mobile-div-feed") { it.channel.structureDiagnosis(FIXTURE_GROUP_ID) }!!
        Log.i("GeckoPocTest", "STRUCTURE_DIV_FEED verdict=${d.verdict} ${d.counts.filterValues { it != 0 }} names=${d.attributeNames}")
        assertEquals("GROUP_OK", d.status)
        assertEquals("EXACT_IDS_AVAILABLE", d.verdict)
        assertEquals(0, d.counts["anchors"])
        assertEquals(0, d.counts["roleArticles"])
        assertTrue(d.counts["mComponents"]!! > 0)
        assertEquals(2, d.counts["scriptExactIds"])
        assertEquals(1, d.counts["netFilterAvailable"])
        // The network layer also sees the page HTML itself (posts 1-2) plus the XHR body (posts 3-4).
        assertEquals(4, d.counts["netExactIds"])
        assertEquals(0, d.counts["ctxPointsSampled"]) // headless: no viewport to sample
        assertTrue(d.counts["mutAddedTotal"]!! >= 2)
    }

    @Test fun structureDiagnosisSeparatesNoIdsFromUnboundIds() {
        val none = withFixture(groupPath, "mobile-div-noids") { it.channel.structureDiagnosis(FIXTURE_GROUP_ID) }!!
        assertEquals("NO_POST_IDS_IN_PAGE_DATA", none.verdict)
        val unbound = withFixture(groupPath, "mobile-div-unbound") { it.channel.structureDiagnosis(FIXTURE_GROUP_ID) }!!
        assertEquals("ID_KEYS_WITHOUT_EXACT_BINDING", unbound.verdict)
        assertEquals(ScanStatus.NO_POSTS, withFixture(groupPath, "mobile-div-unbound") { it.channel.scan(scanRequest()) }.status)
    }

    @Test fun networkEvidenceIsDroppedOnANewPageLoad() {
        // Same session: ids captured on the first page must not leak into the next document.
        val d = withFixture(groupPath, "mobile-div-feed") { page ->
            assertEquals(4, page.channel.structureDiagnosis(FIXTURE_GROUP_ID)!!.counts["netExactIds"])
            page.session.loadUri(page.server.url(groupPath, "mobile-div-noids"))
            delay(2_500) // the old page's port closes and the new page connects its own
            assertTrue(page.channel.awaitPort(30_000))
            page.channel.structureDiagnosis(FIXTURE_GROUP_ID)!!
        }
        assertEquals(0, d.counts["netExactIds"])
        assertEquals("NO_POST_IDS_IN_PAGE_DATA", d.verdict)
    }

    @Test fun pageChangeDuringScanStopsIt() = runBlocking {
        withTimeout(120_000) {
            withContext(Dispatchers.Main) {
                val server = LoopbackFixtureServer { name -> runCatching { context.assets.open(name).bufferedReader().use { it.readText() } }.getOrNull() }
                val session = GeckoSession(GeckoSessionSettings.Builder().build())
                val channel = CollectorChannel(session, fixtureMode = true)
                try {
                    channel.attach(GeckoHost.collectorExtension(context))
                    session.open(GeckoHost.runtime(context))
                    session.setActive(true)
                    session.loadUri(server.url(groupPath, "lazy-feed"))
                    assertTrue(channel.awaitPort(30_000))
                    launch { delay(1_500); session.loadUri(server.url(groupPath, "other")) }
                    val report = channel.scan(ScanRequest(nonce = UUID.randomUUID().toString(), groupId = FIXTURE_GROUP_ID, scrolls = 5, scrollPauseMs = 2_000, allowLoopback = true))
                    assertTrue("got ${report.status}", report.status == ScanStatus.PORT_CLOSED || report.status == ScanStatus.NAVIGATED_AWAY)
                    assertTrue(report.posts.isEmpty())
                } finally {
                    channel.close(); session.close(); server.close()
                }
            }
        }
    }

    @Test fun portsFromNonFacebookPagesAreRefusedOutsideFixtureMode() = runBlocking {
        withTimeout(120_000) {
            withContext(Dispatchers.Main) {
                val server = LoopbackFixtureServer { name -> runCatching { context.assets.open(name).bufferedReader().use { it.readText() } }.getOrNull() }
                val session = GeckoSession(GeckoSessionSettings.Builder().build())
                val channel = CollectorChannel(session, fixtureMode = false)
                try {
                    channel.attach(GeckoHost.collectorExtension(context))
                    session.open(GeckoHost.runtime(context))
                    session.setActive(true)
                    session.loadUri(server.url(groupPath, "feed-basic"))
                    assertFalse(channel.awaitPort(10_000))
                    assertTrue(channel.untrustedPorts >= 1)
                    assertEquals(ScanStatus.NOT_READY, channel.scan(ScanRequest(nonce = "x")).status)
                } finally {
                    channel.close(); session.close(); server.close()
                }
            }
        }
    }
}
