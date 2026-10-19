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
        // One duplicate only (DOM card): 0.2.2 no longer reads the page HTML from the network.
        assertEquals(1, report.diagnostics["duplicatesDropped"])
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

    @Test fun divOnlyMobileFeedYieldsExactIdsFromPageDataOnly() {
        val report = withFixture(groupPath, "mobile-div-feed") { it.channel.scan(scanRequest()) }
        Log.i("GeckoPocTest", "MOBILE_DIV_FEED status=${report.status} posts=${report.posts.map { "${it.postId}:${it.idSource}" }} diag=${report.diagnostics}")
        assertEquals(ScanStatus.OK, report.status)
        // Ids 3 and 4 exist only in an XHR response body, which 0.2.2 never reads.
        assertEquals(setOf("550000000000001", "550000000000002"), report.posts.map { it.postId }.toSet())
        assertEquals(setOf("STRUCTURED"), report.posts.map { it.idSource }.toSet())
        assertEquals(0, report.diagnostics["networkRecords"])
        report.posts.forEach { assertEquals(ScanProtocol.canonicalPermalink(FIXTURE_GROUP_ID, it.postId), it.permalink) }
    }

    @Test fun responseBodiesAreNeverReadEvenWhenTheyHoldIds() {
        // The only id of this page is in an external script response.
        val report = withFixture(groupPath, "mobile-div-script") { it.channel.scan(scanRequest()) }
        assertEquals(ScanStatus.NO_POSTS, report.status)
        val d = withFixture(groupPath, "mobile-div-script") { it.channel.structureDiagnosis(FIXTURE_GROUP_ID, windowMs = 0) }!!
        assertEquals(0, d.counts["netBodyCapture"])
        assertEquals(listOf("data-image-id" to 1), d.numericAttributes)
    }

    @Test fun structureDiagnosisFindsPageDataIdsOnDivOnlyFeed() {
        val d = withFixture(groupPath, "mobile-div-feed") { it.channel.structureDiagnosis(FIXTURE_GROUP_ID, windowMs = 0) }!!
        Log.i("GeckoPocTest", "STRUCTURE_DIV_FEED verdict=${d.verdict} ${d.counts.filterValues { it != 0 }} names=${d.attributeNames}")
        assertEquals("GROUP_OK", d.status)
        assertEquals("EXACT_IDS_AVAILABLE", d.verdict)
        assertEquals(0, d.counts["anchors"])
        assertEquals(0, d.counts["roleArticles"])
        assertTrue(d.counts["mComponents"]!! > 0)
        assertEquals(2, d.counts["scriptExactIds"])
        assertEquals(0, d.counts["netBodyCapture"])
        assertEquals(0, d.counts["ctxPointsSampled"]) // headless: no viewport to sample
        assertTrue(d.counts["mutAddedTotal"]!! >= 2)
    }

    @Test fun structureDiagnosisSeparatesNoIdsFromUnboundIds() {
        val none = withFixture(groupPath, "mobile-div-noids") { it.channel.structureDiagnosis(FIXTURE_GROUP_ID, windowMs = 0) }!!
        assertEquals("NO_POST_IDS_IN_PAGE_DATA", none.verdict)
        val unbound = withFixture(groupPath, "mobile-div-unbound") { it.channel.structureDiagnosis(FIXTURE_GROUP_ID, windowMs = 0) }!!
        assertEquals("ID_KEYS_WITHOUT_EXACT_BINDING", unbound.verdict)
        assertEquals(ScanStatus.NO_POSTS, withFixture(groupPath, "mobile-div-unbound") { it.channel.scan(scanRequest()) }.status)
    }

    @Test fun trafficIsCountedOnlyInsideTheArmedWindowForThisTab() {
        val (first, second) = withFixture(groupPath, "mobile-div-poll", settleMs = 500) { page ->
            val a = page.channel.structureDiagnosis(FIXTURE_GROUP_ID, windowMs = 2_000)!!
            delay(3_000) // polling continues while nothing is armed
            val b = page.channel.structureDiagnosis(FIXTURE_GROUP_ID, windowMs = 2_000)!!
            a to b
        }
        Log.i("GeckoPocTest", "TRAFFIC_WINDOW first=${first.counts.filterKeys { it.startsWith("net") }.filterValues { it != 0 }} paths=${first.requestPaths} second=${second.counts["netTabXhr"]}")
        for (d in listOf(first, second)) {
            assertEquals(1, d.counts["netArmed"])
            assertEquals(1, d.counts["netCountingActive"])
            assertEquals(0, d.counts["netBodyCapture"])
            assertEquals(2, d.counts["netWindowSec"])
            // ~4 polls per 2 s window; the 3 s unarmed pause must not add ~6 more.
            assertTrue("xhr ${d.counts["netTabXhr"]}", d.counts["netTabXhr"]!! in 2..6)
            assertEquals(0, d.counts["netTabMainFrame"])
            assertTrue(d.requestPaths.all { it.first == "/data" })
        }
    }

    @Test fun anotherTabsTrafficIsNotCounted() {
        val d = withFixture(groupPath, "mobile-div-noids", settleMs = 500) { page ->
            // A second session (another tab) keeps polling while this tab is armed.
            val other = GeckoSession(GeckoSessionSettings.Builder().build())
            other.open(GeckoHost.runtime(context))
            other.setActive(true)
            other.loadUri(page.server.url(groupPath, "mobile-div-poll"))
            try {
                delay(1_000)
                page.channel.structureDiagnosis(FIXTURE_GROUP_ID, windowMs = 2_000)!!
            } finally {
                other.close()
            }
        }
        assertEquals(1, d.counts["netArmed"])
        assertEquals(0, d.counts["netReqWithTab"])
        assertEquals(0, d.counts["netTabXhr"])
    }

    private fun control(fixture: String = "network-control", other: String? = null) =
        runBlocking { withTimeout(90_000) { NetworkControlRunner(context).run(fixture, windowMs = 3_000, otherTabFixture = other) } }

    @Test fun networkControlSeesPageRequestsOfTheArmedTab() {
        val result = control()
        Log.i("GeckoPocTest", "NETWORK_CONTROL ok=${result.status} ${result.counts.filterValues { it != 0 }}")
        assertEquals(ControlStatus.LISTENER_OK, result.status)
        assertTrue(result.counts["controlTab"]!! >= 2)
        assertEquals(0, result.counts["controlOtherTab"])
        assertEquals(1, result.counts["apiWebRequest"])
        assertEquals(1, result.counts["apiListener"])
        assertEquals(0, result.counts["netBodyCapture"])
        assertEquals(0, result.counts["netReqWithTab"]) // control hits never count as page data
    }

    @Test fun networkControlArmedWithZeroRequestsIsNotObserved() {
        val result = control(fixture = "mobile-div-noids")
        assertEquals(ControlStatus.LISTENER_NOT_OBSERVED, result.status)
        assertEquals(1, result.counts["netArmed"])
        assertEquals(1, result.counts["backgroundAnswered"])
        assertEquals(0, result.counts["controlTab"])
    }

    @Test fun networkControlRequestsFromAnotherTabAreWrongTab() {
        val result = control(fixture = "mobile-div-noids", other = "network-control")
        Log.i("GeckoPocTest", "NETWORK_CONTROL wrongTab=${result.status} ${result.counts.filterValues { it != 0 }}")
        assertEquals(ControlStatus.WRONG_TAB, result.status)
        assertEquals(0, result.counts["controlTab"])
        assertTrue(result.counts["controlOtherTab"]!! >= 1)
    }

    /** One load measurement in a fresh session, the way the app runs it (armed before loadUri). */
    private fun measureLoad(fixture: String, path: String = groupPath, windowMs: Int = 4_000, otherTab: String? = null, aliveForMs: Long? = null): LoadResult = runBlocking {
        withTimeout(90_000) {
            withContext(Dispatchers.Main) {
                val server = LoopbackFixtureServer { name -> runCatching { context.assets.open(name).bufferedReader().use { it.readText() } }.getOrNull() }
                val session = GeckoSession(GeckoSessionSettings.Builder().build())
                val channel = CollectorChannel(session, fixtureMode = true)
                val other = otherTab?.let { GeckoSession(GeckoSessionSettings.Builder().build()) }
                val otherChannel = other?.let { CollectorChannel(it, fixtureMode = true) }
                try {
                    channel.attach(GeckoHost.collectorExtension(context))
                    session.open(GeckoHost.runtime(context))
                    session.setActive(true)
                    other?.let {
                        otherChannel!!.attach(GeckoHost.collectorExtension(context))
                        it.open(GeckoHost.runtime(context)); it.setActive(true)
                        it.loadUri(server.url(groupPath, otherTab!!))
                        // Complete the noise tab navigation BEFORE arming the next-main-frame
                        // measurement. Its polling continues throughout the measured window.
                        // Otherwise this tab may win the race and become the measured tab.
                        assertTrue(otherChannel.awaitPort(30_000))
                        assertTrue(otherChannel.probe() != null)
                    }
                    val started = System.currentTimeMillis()
                    LoadMeasurementRunner(GeckoHost.background).run(
                        session, channel, server.url(path, fixture), FIXTURE_GROUP_ID, windowMs, allowLoopback = true,
                        sessionAlive = { aliveForMs == null || System.currentTimeMillis() - started < aliveForMs },
                    )
                } finally {
                    channel.close(); otherChannel?.close(); runCatching { other?.close() }; session.close(); server.close()
                }
            }
        }
    }

    @Test fun loadMeasurementCountsTheWholeApprovedGroupLoad() {
        val r = measureLoad("load-group")
        Log.i("GeckoPocTest", "LOAD_GROUP status=${r.status} reason=${r.reason} ${r.counts.filterValues { it != 0 }} dom=${r.dom} paths=${r.requestPaths}")
        assertEquals(LoadStatus.PASS, r.status)
        assertTrue(r.armedBeforeNavigation)
        assertEquals(1, r.counts["loadBound"])
        assertEquals(1, r.counts["loadMainFrames"])
        assertEquals(1, r.counts["loadPageMainFrame"])
        assertEquals(1, r.counts["loadDocCompleted"])
        assertEquals(2, r.counts["loadPageXhr"])
        assertEquals(1, r.counts["loadPageScript"])
        assertEquals(1, r.counts["loadPageImage"])
        assertEquals(0, r.counts["loadBodyCapture"])
        assertEquals(1, r.dom!!["domGroupOk"])
        assertEquals(LoadMeasurement.apiRequests(r.counts), 2)
    }

    @Test fun loadMeasurementFreezesOnLoginCheckpointCaptchaAndOtherGroup() {
        for ((fixture, reason) in listOf("load-to-login" to "LOGIN", "load-to-checkpoint" to "CHECKPOINT", "load-to-captcha" to "CAPTCHA", "load-to-other-group" to "OTHER_GROUP")) {
            val r = measureLoad(fixture, windowMs = 3_000)
            assertEquals(fixture, LoadStatus.FAIL, r.status)
            assertEquals(fixture, reason, r.reason)
            assertEquals(fixture, 1, r.counts["loadMainFrames"]) // only the approved document, nothing after it
        }
    }

    @Test fun loadMeasurementIgnoresAnotherTab() {
        val r = measureLoad("load-group", otherTab = "load-noise")
        assertEquals(LoadStatus.PASS, r.status)
        assertEquals(2, r.counts["loadPageXhr"]) // the other tab polls, but only this tab's 2 fetches count
        assertTrue(r.counts["loadOtherTab"]!! >= 1)
    }

    @Test fun loadMeasurementNeverBindsToANonApprovedPage() {
        val r = measureLoad("other", path = "/groups/999999999999/", windowMs = 3_000)
        assertEquals(LoadStatus.FAIL, r.status)
        assertEquals("MAIN_FRAME_NOT_SEEN", r.reason)
        assertEquals(0, r.counts["loadPageXhr"])
    }

    @Test fun loadMeasurementSessionClosedThenCleanNextRun() {
        val closed = measureLoad("load-group", windowMs = 4_000, aliveForMs = 1_000)
        assertEquals(LoadStatus.FAIL, closed.status)
        assertEquals("SESSION_CLOSED", closed.reason)
        // The aborted measurement left nothing behind: the next one starts from zero.
        val next = measureLoad("load-group")
        assertEquals(LoadStatus.PASS, next.status)
        assertEquals(2, next.counts["loadPageXhr"])
        assertEquals(1, next.counts["loadMainFrames"])
    }

    @Test fun loadMeasurementIsReadOnceAndCleared() = runBlocking {
        withTimeout(30_000) {
            withContext(Dispatchers.Main) {
                GeckoHost.collectorExtension(context)
                val background = GeckoHost.background
                assertTrue(background.awaitPort(10_000))
                val nonce = UUID.randomUUID().toString()
                assertTrue(LoadMeasurement.parseArmed(background.request(LoadMeasurement.armRequest(nonce, FIXTURE_GROUP_ID, 2_000)), nonce))
                assertTrue(LoadMeasurement.parseRead(background.request(LoadMeasurement.readRequest(nonce)), nonce) != null)
                assertEquals(null, LoadMeasurement.parseRead(background.request(LoadMeasurement.readRequest(nonce)), nonce))
            }
        }
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
    @Test fun visiblePostsUsesFreshConsentAndStopsOnPageChange() {
        ActivityScenario.launch(GeckoTestHostActivity::class.java).use { scenario ->
            var host: GeckoTestHostActivity? = null
            scenario.onActivity { host = it }
            runBlocking { withTimeout(120_000) { withContext(Dispatchers.Main) {
                val server = LoopbackFixtureServer { name -> runCatching { context.assets.open(name).bufferedReader().use { it.readText() } }.getOrNull() }
                val session = GeckoSession(GeckoSessionSettings.Builder().build())
                var stopped = false
                val channel = CollectorChannel(session, fixtureMode = true, onVisibleStop = { stopped = true })
                try {
                    channel.attach(GeckoHost.collectorExtension(context))
                    session.open(GeckoHost.runtime(context))
                    host!!.geckoView.setSession(session)
                    session.setActive(true)
                    session.loadUri(server.url(groupPath, "visible-posts"))
                    assertTrue(channel.awaitPort(30_000))
                    delay(1_000)
                    assertEquals(null, channel.visiblePosts(false, FIXTURE_GROUP_ID))
                    val report = channel.visiblePosts(true, FIXTURE_GROUP_ID)
                    assertTrue("report=$report", report?.contains("confirmedIds: 1") == true)
                    assertTrue(report?.contains("priceCandidates: 1") == true)
                    assertFalse(report.orEmpty().contains("450 000"))
                    for ((fixture, key) in listOf("visible-mobile-text" to "mobileTextBlocks", "visible-plain-text" to "fallbackTextBlocks")) {
                        session.loadUri(server.url(groupPath, fixture))
                        delay(1_000)
                        assertTrue(channel.awaitPort(30_000))
                        val mobileReport = channel.visiblePosts(true, FIXTURE_GROUP_ID)
                        assertTrue("$fixture report=$mobileReport", mobileReport?.contains("$key: 1") == true)
                        assertTrue(mobileReport?.contains("candidates: 1") == true)
                        assertTrue(mobileReport?.contains("priceCandidates: 0") == true)
                        assertFalse(mobileReport.orEmpty().contains("Sprzedam"))
                    }
                    session.loadUri(server.url(groupPath, "visible-ancestors"))
                    delay(1_000)
                    assertTrue(channel.awaitPort(30_000))
                    val ancestorReport = channel.visiblePosts(true, FIXTURE_GROUP_ID)
                    assertTrue("report=$ancestorReport", ancestorReport?.contains("ancestorExactAndPhoto: 1") == true)
                    assertTrue(ancestorReport?.contains("ancestorWithArea: 1") == true)
                    assertTrue(ancestorReport?.contains("ancestorFeedStops: 1") == true)
                    assertTrue(ancestorReport?.contains("confirmedIds: 0") == true)
                    assertFalse(ancestorReport.orEmpty().contains("123456789/"))
                    session.loadUri(server.url(groupPath, "visible-attributes"))
                    delay(1_000)
                    assertTrue(channel.awaitPort(30_000))
                    val attributeReport = channel.visiblePosts(true, FIXTURE_GROUP_ID)
                    assertTrue("report=$attributeReport", attributeReport?.contains("attrExactIdHints: 1") == true)
                    assertTrue(attributeReport?.contains("attrActionMarkers: 1") == true)
                    assertTrue(attributeReport?.contains("attrStoreMarkers: 1") == true)
                    assertTrue(attributeReport?.contains("confirmedIds: 0") == true)
                    assertFalse(attributeReport.orEmpty().contains("123456789/"))
                    assertFalse(attributeReport.orEmpty().contains("not a post ID"))
                    session.loadUri(server.url("/login/", "login"))
                    delay(2_000)
                    assertTrue(stopped)
                    assertEquals(null, channel.visiblePosts(true, FIXTURE_GROUP_ID))
                } finally {
                    channel.close(); host!!.geckoView.releaseSession(); session.close(); server.close()
                }
            } } }
        }
    }

}
