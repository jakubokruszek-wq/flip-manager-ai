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
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.AllowOrDeny
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

    @Test fun shareResolverFollowsRealHttpRedirectWithPrivateContextAndRejectsForeignGroup() {
        ActivityScenario.launch(GeckoTestHostActivity::class.java).use { scenario ->
            var host: GeckoTestHostActivity? = null
            scenario.onActivity { host = it }
            runBlocking { withTimeout(90_000) { withContext(Dispatchers.Main) {
                val sharePath = "/share/p/fixture1/"
                val postPath = "/groups/$FIXTURE_GROUP_ID/posts/550000000000099/"
                val foreignPath = "/groups/other/posts/550000000000099/"
                val server = LoopbackFixtureServer(redirects = mapOf(sharePath to postPath, "/share/p/fixture2/" to foreignPath), pages = mapOf(postPath to "share-link-post", foreignPath to "share-link-post")) { name -> runCatching { context.assets.open(name).bufferedReader().use { it.readText() } }.getOrNull() }
                val origin = "http://127.0.0.1:${server.port}"
                val session = GeckoSession(GeckoSessionSettings.Builder().build())
                var gate = ShareLinkResolver(FIXTURE_GROUP_ID, { android.os.SystemClock.elapsedRealtime() }, origin)
                val channel = CollectorChannel(session, fixtureMode = true, onShareStop = { gate.stop("UNSAFE_DOCUMENT") })
                var currentUrl: String? = null
                var complete = false
                session.navigationDelegate = object : GeckoSession.NavigationDelegate {
                    override fun onLoadRequest(s: GeckoSession, r: GeckoSession.NavigationDelegate.LoadRequest): GeckoResult<AllowOrDeny> {
                        // Fixture-only trace. Production code never logs navigation URLs.
                        Log.i("GeckoPocTest", "SHARE_REQUEST uri=${r.uri} redirect=${r.isRedirect} gesture=${r.hasUserGesture}")
                        val warmup=gate.status==ShareLinkResolver.Status.IDLE && r.uri==server.url(groupPath,"other")
                        return GeckoResult.fromValue(if(warmup || gate.request(r.uri,r.isRedirect,r.target == GeckoSession.NavigationDelegate.TARGET_WINDOW_NEW,r.hasUserGesture)) AllowOrDeny.ALLOW else AllowOrDeny.DENY)
                    }
                    override fun onLocationChange(s: GeckoSession, u: String?, p: MutableList<GeckoSession.PermissionDelegate.ContentPermission>, gesture: Boolean) {
                        Log.i("GeckoPocTest", "SHARE_LOCATION uri=$u gesture=$gesture")
                        currentUrl=u;if(gate.active)gate.location(u)
                    }
                }
                session.progressDelegate = object : GeckoSession.ProgressDelegate {
                    override fun onPageStart(s: GeckoSession, u: String) { complete=false }
                    override fun onPageStop(s: GeckoSession, success: Boolean) { complete=success }
                }
                try {
                    channel.attach(GeckoHost.collectorExtension(context));session.open(GeckoHost.runtime(context));host!!.geckoView.setSession(session);session.setActive(true)
                    // Match the real entry point: a fully loaded approved group, not a just-opened about:blank session.
                    session.loadUri(server.url(groupPath,"other"));assertTrue(channel.awaitPort(15_000))
                    withTimeout(15_000){while(!complete || currentUrl!=server.url(groupPath,"other"))delay(100)}
                    delay(200);currentUrl=null;complete=false
                    assertTrue(gate.begin(origin+sharePath,true));session.loadUri(origin+sharePath)
                    withTimeout(30_000) { while(gate.active) {
                        val u=currentUrl
                        if(u!=null && complete && channel.isConnected && channel.connectedUrl==u) {
                            val c=channel.shareLinkContext(u,true);if(c!=null)gate.confirm(u,c.first,c.second)
                        }
                        gate.tick();delay(100)
                    } }
                    Log.i("GeckoPocTest", "SHARE_RESOLVER ${gate.report()}")
                    assertEquals(ShareLinkResolver.Status.CONFIRMED,gate.status);assertEquals(2,gate.requests)
                    assertFalse(gate.report().contains("550000000000099"));assertFalse(gate.report().contains(origin))
                    assertNull(channel.shareLinkContext(origin+postPath,false))
                    channel.stopShareLinkContext()
                    // A fresh consent arms the live document guard; hiding the real Gecko session must revoke it.
                    currentUrl=null;complete=false
                    gate=ShareLinkResolver(FIXTURE_GROUP_ID,{android.os.SystemClock.elapsedRealtime()},origin)
                    assertTrue(gate.begin(origin+sharePath,true));session.loadUri(origin+sharePath)
                    withTimeout(15_000){while(currentUrl!=origin+postPath || !complete || channel.connectedUrl!=origin+postPath)delay(100)}
                    val contextCheck=channel.shareLinkContext(origin+postPath,true)
                    assertEquals(true to true,contextCheck)
                    session.setActive(false)
                    withTimeout(5_000){while(gate.active)delay(100)}
                    assertEquals(ShareLinkResolver.Status.STOP,gate.status);assertEquals("UNSAFE_DOCUMENT",gate.reason)
                    session.setActive(true);channel.stopShareLinkContext();delay(300)
                    gate=ShareLinkResolver(FIXTURE_GROUP_ID,{android.os.SystemClock.elapsedRealtime()},origin)
                    assertTrue(gate.begin(origin+"/share/p/fixture2/",true));session.loadUri(origin+"/share/p/fixture2/")
                    withTimeout(10_000){while(gate.active){gate.tick();delay(100)}}
                    assertEquals(ShareLinkResolver.Status.STOP,gate.status);assertEquals("UNVERIFIED_DESTINATION",gate.reason)
                    // Paused/cancelled sessions reject any late document or redirect confirmation.
                    val cancelled=ShareLinkResolver(FIXTURE_GROUP_ID,{android.os.SystemClock.elapsedRealtime()},origin)
                    assertTrue(cancelled.begin(origin+sharePath,true));cancelled.stop("PAUSED")
                    assertFalse(cancelled.request(origin+postPath,true));assertFalse(cancelled.confirm(origin+postPath,true,true))
                } finally { channel.stopShareLinkContext();channel.close();host!!.geckoView.releaseSession();session.close();server.close() }
            } } }
        }
    }

    @Test fun terminalLinkReportSurvivesPauseRecreationAndCanBeCopiedWithoutOpeningFacebook() {
        val prefs=context.getSharedPreferences("share_link_terminal_result_v1",Context.MODE_PRIVATE)
        val original=prefs.getString("last",null)
        try {
            ActivityScenario.launch(PocActivity::class.java).use { scenario ->
                val gate=ShareLinkResolver(now={0L})
                assertTrue(gate.begin("https://www.facebook.com/share/p/syntheticToken01/",true));gate.stop("PAUSED")
                val terminal=ShareLinkResult.snapshot(gate)!!
                scenario.onActivity { activity ->
                    activity.publishShareResult(terminal,true)
                    assertTrue(activity.lastShareResultDialog!!.isShowing)
                    val message=activity.lastShareResultDialog!!.findViewById<android.widget.TextView>(android.R.id.message).text.toString()
                    assertTrue(message.contains("LINK 0.4.1"));assertTrue(message.contains("PAUSED"));assertFalse(message.contains("synthetic"));assertFalse(message.contains("https:"))
                    activity.lastShareResultDialog!!.getButton(android.app.AlertDialog.BUTTON_NEUTRAL).performClick()
                    val clipboard=activity.getSystemService(android.content.ClipboardManager::class.java)
                    assertEquals(message,clipboard.primaryClip!!.getItemAt(0).text.toString())
                }
                scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
                assertEquals("PAUSED",ShareLinkResultStore(context).read()!!.reason)
                scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
                scenario.recreate()
                scenario.onActivity { activity ->
                    activity.showLastShareResult()
                    val message=activity.lastShareResultDialog!!.findViewById<android.widget.TextView>(android.R.id.message).text.toString()
                    assertTrue(message.contains("PAUSED"));assertFalse(message.contains("synthetic"));assertEquals("PAUSED",ShareLinkResultStore(context).read()!!.reason)
                    activity.lastShareResultDialog!!.dismiss()
                    val root=activity.findViewById<android.view.ViewGroup>(android.R.id.content)
                    root.findViewWithTag<android.widget.Button>("poc.tool.tools").performClick()
                    assertTrue(activity.diagnosticsDialog!!.window!!.decorView.findViewWithTag<android.widget.Button>("poc.tool.lastShareLinkResult").isEnabled)
                }
            }
        } finally {
            prefs.edit().apply { if(original==null)remove("last")else putString("last",original) }.commit()
        }
    }

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

    @Test fun optInResponseStreamReusesDesktopParserWithoutChangingPageBytes() {
        ActivityScenario.launch(GeckoTestHostActivity::class.java).use { scenario ->
            var host: GeckoTestHostActivity? = null
            scenario.onActivity { host = it }
            runBlocking { withTimeout(120_000) { withContext(Dispatchers.Main) {
                val server = LoopbackFixtureServer { name -> runCatching { context.assets.open(name).bufferedReader().use { it.readText() } }.getOrNull() }
                val session = GeckoSession(GeckoSessionSettings.Builder().build())
                val channel = CollectorChannel(session, fixtureMode = true)
                try {
                    channel.attach(GeckoHost.collectorExtension(context))
                    session.open(GeckoHost.runtime(context)); host!!.geckoView.setSession(session); session.setActive(true)
                    session.loadUri(server.url(groupPath, "response-window"))
                    assertTrue(channel.awaitPort(30_000)); delay(1_000)
                    assertNull(channel.responseDiagnosis(false, FIXTURE_GROUP_ID, 2_000))
                    val report = channel.responseDiagnosis(true, FIXTURE_GROUP_ID, 2_000)
                    Log.i("GeckoPocTest", "RESPONSE_STREAM $report")
                    assertTrue("report=$report", report?.contains("responseApiAvailable: 1") == true)
                    assertTrue("report=$report", report?.contains("responseExactIds: 1") == true)
                    assertTrue("no passive endpoint rejection: $report", (Regex("responseEndpointRejected: ([0-9]+)").find(report.orEmpty())?.groupValues?.get(1)?.toIntOrNull() ?: 0) > 0)
                    assertTrue(report?.contains("responsePriceSignals: 1") == true)
                    assertTrue(report?.contains("responseAreaSignals: 1") == true)
                    assertFalse(report.orEmpty().contains("PRIVATE")); assertFalse(report.orEmpty().contains("550000000000003"))
                    // The page creates an article ONLY after receiving the original UTF8 body.
                    assertEquals(1, channel.probe()!!.articles)
                    val cancelStarted = android.os.SystemClock.elapsedRealtime()
                    launch { delay(500); channel.abortResponseDiagnosis() }
                    assertNull(channel.responseDiagnosis(true, FIXTURE_GROUP_ID, 15_000, autoScrollConsent = true))
                    assertTrue("native abort waited for full window", android.os.SystemClock.elapsedRealtime() - cancelStarted < 10_000)
                    val again = channel.responseDiagnosis(true, FIXTURE_GROUP_ID, 4_000, autoScrollConsent = true)
                    assertTrue("no real scroll: $again", (Regex("responseScrollMoves: ([0-9]+)").find(again.orEmpty())?.groupValues?.get(1)?.toIntOrNull() ?: 0) > 0)
                    assertTrue("scroll did not trigger the second fixture ID: $again", again?.contains("responseExactIds: 2") == true)
                    launch { delay(500); session.loadUri(server.url("/login/", "login")) }
                    val stopped = channel.responseDiagnosis(true, FIXTURE_GROUP_ID, 2_000)
                    assertTrue("stopped=$stopped", stopped == null || !stopped.contains("responseExactIds: 1"))
                    assertNull(channel.responseDiagnosis(true, FIXTURE_GROUP_ID, 500))
                } finally { channel.close(); host!!.geckoView.releaseSession(); session.close(); server.close() }
            } } }
        }
    }

    @Test fun integratedMainTransportUsesNativeConsentPrivateApiAndNestedFeedWithStopAndCleanRetry() {
        ActivityScenario.launch(GeckoTestHostActivity::class.java).use { scenario ->
            var host: GeckoTestHostActivity?=null
            scenario.onActivity { host=it }
            runBlocking { withTimeout(120_000) { withContext(Dispatchers.Main) {
                val server=LoopbackFixtureServer { name -> runCatching { context.assets.open(name).bufferedReader().use { it.readText() } }.getOrNull() }
                val session=GeckoSession(GeckoSessionSettings.Builder().build())
                val channel=CollectorChannel(session,fixtureMode=true)
                try {
                    channel.attach(GeckoHost.collectorExtension(context))
                    session.open(GeckoHost.runtime(context));host!!.geckoView.setSession(session);session.setActive(true)
                    val target=server.url(groupPath,"main-native")
                    session.loadUri(target);assertTrue(channel.awaitPort(30_000));delay(700)
                    assertNull(channel.mainTransport(false,FIXTURE_GROUP_ID,8_000,autoScrollConsent=true))
                    val report=channel.mainTransport(true,FIXTURE_GROUP_ID,8_000,autoScrollConsent=true)
                    Log.i("GeckoPocTest","MAIN_INTEGRATED $report")
                    for(field in listOf("installed: 1","fetchBodies: 1","xhrBodies: 1","completed: 2","exactIds: 1","duplicates: 1","textRecords: 1","priceSignals: 1","areaSignals: 1","scrollSteps: 5","scrollMoves: 5","errors: 0"))
                        assertTrue("missing $field: $report",report?.contains(field)==true)
                    assertFalse(report.orEmpty().contains("LOCAL_MAIN_FIXTURE"));assertFalse(report.orEmpty().contains("550000000000012"))
                    // Actual visibility transition must stop a long attempt promptly, not wait 20 seconds.
                    val started=android.os.SystemClock.elapsedRealtime()
                    launch { delay(1_200);session.setActive(false) }
                    val stopped=channel.mainTransport(true,FIXTURE_GROUP_ID,20_000)
                    assertTrue("stopped=$stopped",stopped==null || stopped.contains("• STOP"))
                    assertTrue("STOP was delayed",android.os.SystemClock.elapsedRealtime()-started<8_000)
                    session.setActive(true);delay(700)
                    val clean=channel.mainTransport(true,FIXTURE_GROUP_ID,2_000)
                    assertTrue("clean=$clean",clean?.contains("installed: 1")==true)
                    assertTrue(clean?.contains("exactIds: 0")==true);assertTrue(clean?.contains("bytes: 0")==true)
                    launch { delay(900);session.loadUri(server.url("/login/","login")) }
                    val navigation=channel.mainTransport(true,FIXTURE_GROUP_ID,10_000)
                    assertTrue("navigation=$navigation",navigation==null || navigation.contains("• STOP"))
                } finally { GeckoHost.background.abortResponses();channel.close();host!!.geckoView.releaseSession();session.close();server.close() }
            } } }
        }
    }

    @Test fun mainWorldDesktopTransportRunsBeforePageScriptsAndReadsOnlyFreshConsentedLocalFixtures() {
        ActivityScenario.launch(GeckoTestHostActivity::class.java).use { scenario ->
            var host: GeckoTestHostActivity? = null
            scenario.onActivity { host = it }
            runBlocking { withTimeout(120_000) { withContext(Dispatchers.Main) {
                val server=LoopbackFixtureServer { name -> runCatching { context.assets.open(name).bufferedReader().use { it.readText() } }.getOrNull() }
                val session=GeckoSession(GeckoSessionSettings.Builder().build())
                val runtime=GeckoHost.runtime(context)
                val extension=runtime.webExtensionController.ensureBuiltIn("resource://android/assets/ext/main_lab/","main-lab@flip-manager.local").await()!!
                var ready=kotlinx.coroutines.CompletableDeferred<org.mozilla.geckoview.WebExtension.Port>()
                val pending=HashMap<String,kotlinx.coroutines.CompletableDeferred<org.json.JSONObject>>()
                val delegate=object:org.mozilla.geckoview.WebExtension.MessageDelegate {
                    override fun onConnect(port:org.mozilla.geckoview.WebExtension.Port) {
                        assertTrue(port.sender.isTopLevel)
                        assertTrue(port.sender.url?.startsWith("http://127.0.0.1:${server.port}/groups/$FIXTURE_GROUP_ID/") == true)
                        port.setDelegate(object:org.mozilla.geckoview.WebExtension.PortDelegate {
                            override fun onPortMessage(message:Any,port:org.mozilla.geckoview.WebExtension.Port) {
                                val json=ScanProtocol.asJson(message) ?: return
                                if(json.optString("type")=="mainLabResult")pending.remove(json.optString("nonce"))?.complete(json.getJSONObject("counts"))
                            }
                        })
                        ready.complete(port)
                    }
                }
                session.webExtensionController.setMessageDelegate(extension,delegate,"mainLab")
                suspend fun load(consent:Boolean):org.mozilla.geckoview.WebExtension.Port {
                    ready=kotlinx.coroutines.CompletableDeferred()
                    val target=server.url(groupPath,"main-world")+"&labNonce="+UUID.randomUUID()+(if(consent) "&labConsent=once" else "")
                    session.loadUri(target)
                    val port=ready.await();delay(2_000);return port
                }
                suspend fun command(port:org.mozilla.geckoview.WebExtension.Port,op:String):org.json.JSONObject {
                    val nonce=UUID.randomUUID().toString();val result=kotlinx.coroutines.CompletableDeferred<org.json.JSONObject>();pending[nonce]=result
                    port.postMessage(org.json.JSONObject().put("op",op).put("nonce",nonce))
                    return result.await()
                }
                try {
                    session.open(runtime);host!!.geckoView.setSession(session);session.setActive(true)
                    val passive=command(load(false),"read")
                    for(field in listOf("installed","beforePage","fetchIntact","xhrIntact"))assertEquals("passive $field: $passive",1,passive.getInt(field))
                    for(field in listOf("armed","bytes","exactIds","fetchBodies","xhrBodies"))assertEquals("passive $field: $passive",0,passive.getInt(field))
                    val port=load(true);val captured=command(port,"read")
                    Log.i("GeckoPocTest","MAIN_WORLD_FIXTURE $captured")
                    for(field in listOf("installed","beforePage","armed","fetchBodies","xhrBodies","exactIds","duplicates","textRecords","priceSignals","areaSignals","fetchIntact","xhrIntact"))assertEquals("capture $field: $captured",1,captured.getInt(field))
                    assertTrue(captured.getInt("bytes")>300);assertEquals(0,captured.getInt("rejected"))
                    assertFalse(captured.toString().contains("LOCAL_MAIN_FIXTURE"));assertFalse(captured.toString().contains("550000000000012"))
                    val stopped=command(port,"stop")
                    assertEquals(1,stopped.getInt("stopped"));assertEquals(0,stopped.getInt("bytes"));assertEquals(0,stopped.getInt("exactIds"));assertEquals(0,stopped.getInt("armed"))
                    val clean=command(load(false),"read")
                    assertEquals(0,clean.getInt("armed"));assertEquals(0,clean.getInt("bytes"));assertEquals(0,clean.getInt("exactIds"))
                } finally { host!!.geckoView.releaseSession();session.close();server.close();runtime.webExtensionController.uninstall(extension).await() }
            } } }
        }
    }

    @Test fun documentReadRequiresFreshScopeAndRealGeckoDeliversOnlyApprovedInitialHtml() {
        ActivityScenario.launch(GeckoTestHostActivity::class.java).use { scenario ->
            var host: GeckoTestHostActivity? = null
            scenario.onActivity { host = it }
            runBlocking { withTimeout(120_000) { withContext(Dispatchers.Main) {
                val server = LoopbackFixtureServer { name -> runCatching { context.assets.open(name).bufferedReader().use { it.readText() } }.getOrNull() }
                val session = GeckoSession(GeckoSessionSettings.Builder().build())
                val channel = CollectorChannel(session, fixtureMode = true)
                val background = GeckoHost.background
                try {
                    channel.attach(GeckoHost.collectorExtension(context))
                    session.open(GeckoHost.runtime(context)); host!!.geckoView.setSession(session); session.setActive(true)
                    assertTrue(background.awaitPort(10_000))
                    val target = server.url(groupPath, "response-document")
                    session.loadUri(target); assertTrue(channel.awaitPort(30_000)); delay(1_000)
                    assertNull(channel.prepareResponseLoad(false,FIXTURE_GROUP_ID,4_000,documentConsent=true))
                    val passive=ResponseLoadRunner(background).run(session,channel,target,FIXTURE_GROUP_ID,4_000,alive={true},willLoad={})
                    assertTrue("passive=$passive",passive?.contains("Dokument grupy: Read=0")==true)
                    assertTrue(passive?.contains("responseBytes: 0")==true)
                    val report=ResponseLoadRunner(background).run(session,channel,target,FIXTURE_GROUP_ID,5_000,documentConsent=true,alive={true},willLoad={})
                    Log.i("GeckoPocTest","DOCUMENT_CAPTURE $report")
                    for(field in listOf("Dokument grupy: Read=1, Completed=1", "JsonBlocks=3", "Permalinks=1", "responseLoadVerified: 1", "responseExactIds: 2", "responseRecordsWithText: 2", "responsePriceSignals: 2", "responseAreaSignals: 2", "responseAutoScroll: 0", "responseFiltered: 1"))
                        assertTrue("missing $field: $report",report?.contains(field)==true)
                    assertFalse(report.orEmpty().contains("PRIVATE")); assertFalse(report.orEmpty().contains("550000000000007"))
                    launch { delay(800); session.loadUri(server.url("/login/","login")) }
                    val stopped=ResponseLoadRunner(background).run(session,channel,target,FIXTURE_GROUP_ID,3_000,documentConsent=true,alive={true},willLoad={})
                    assertTrue("stopped=$stopped",stopped==null || stopped.contains("• STOP"))
                    assertFalse(stopped.orEmpty().contains("responseExactIds: 1"))
                    session.loadUri(target);assertTrue(channel.awaitPort(30_000));delay(1_000)
                    val clean=ResponseLoadRunner(background).run(session,channel,target,FIXTURE_GROUP_ID,4_000,alive={true},willLoad={})
                    assertTrue("clean=$clean",clean?.contains("Dokument grupy: Read=0")==true)
                    assertTrue(clean?.contains("responseBytes: 0")==true)
                } finally { background.abortResponses();channel.close();host!!.geckoView.releaseSession();session.close();server.close() }
            } } }
        }
    }

    @Test fun responseLoadCapturesOnlyFreshConsentedInitialRequest() {
        ActivityScenario.launch(GeckoTestHostActivity::class.java).use { scenario ->
            var host: GeckoTestHostActivity? = null
            scenario.onActivity { host = it }
            runBlocking { withTimeout(120_000) { withContext(Dispatchers.Main) {
                val server = LoopbackFixtureServer { name -> runCatching { context.assets.open(name).bufferedReader().use { it.readText() } }.getOrNull() }
                val session = GeckoSession(GeckoSessionSettings.Builder().build())
                val channel = CollectorChannel(session, fixtureMode = true)
                val background = GeckoHost.background
                try {
                    val extension = GeckoHost.collectorExtension(context)
                    channel.attach(extension)
                    session.open(GeckoHost.runtime(context)); host!!.geckoView.setSession(session); session.setActive(true)
                    assertTrue("existing background port", background.awaitPort(10_000))
                    val target = server.url(groupPath, "response-load")
                    session.loadUri(target)
                    assertTrue(channel.awaitPort(30_000)); delay(1_000)
                    assertNull(channel.prepareResponseLoad(false, FIXTURE_GROUP_ID, 4_000))
                    val report = ResponseLoadRunner(background).run(session,channel,target,FIXTURE_GROUP_ID,5_000,alive={true},willLoad={})
                    Log.i("GeckoPocTest", "RESPONSE_INITIAL $report")
                    for (field in listOf("responseLoadMode: 1","responseLoadNavigation: 1","responseLoadVerified: 1","responseExactIds: 1","responseCompleted: 1"))
                        assertTrue("missing $field: $report", report?.contains(field)==true)
                    assertFalse(report.orEmpty().contains("PRIVATE")); assertFalse(report.orEmpty().contains("550000000000003"))
                    assertEquals(1, channel.probe()!!.articles)
                    launch { delay(800); session.loadUri(server.url("/login/", "login")) }
                    val stopped = ResponseLoadRunner(background).run(session,channel,target,FIXTURE_GROUP_ID,3_000,alive={true},willLoad={})
                    assertTrue("stopped=$stopped", stopped==null || stopped.contains("• STOP"))
                    assertFalse(stopped.orEmpty().contains("responseExactIds: 1"))
                } finally { background.abortResponses(); channel.close(); host!!.geckoView.releaseSession(); session.close(); server.close() }
            } } }
        }
    }

    @Test fun combinedInitialLoadAndScrollUsesNativeNavigationGateAndFreshConsent() {
        ActivityScenario.launch(GeckoTestHostActivity::class.java).use { scenario ->
            var host: GeckoTestHostActivity? = null
            scenario.onActivity { host = it }
            runBlocking { withTimeout(120_000) { withContext(Dispatchers.Main) {
                val server = LoopbackFixtureServer { name -> runCatching { context.assets.open(name).bufferedReader().use { it.readText() } }.getOrNull() }
                val session = GeckoSession(GeckoSessionSettings.Builder().build())
                val background = GeckoHost.background
                val gate = ResponseReloadGate()
                var unexpectedStop = false
                fun stop() { if (gate.active) unexpectedStop = true; gate.cancel(); background.abortResponses() }
                val channel = CollectorChannel(session, fixtureMode = true, onVisibleStop = { stop() },
                    onPageDisconnect = { if (gate.active && !gate.allowOldDisconnect()) stop() }, onPageConnected = { gate.connected() })
                // Exercise the actual Gecko callback order against the same gate used by PocActivity.
                session.navigationDelegate = object : GeckoSession.NavigationDelegate {
                    override fun onLoadRequest(session: GeckoSession, request: GeckoSession.NavigationDelegate.LoadRequest): GeckoResult<AllowOrDeny> {
                        if (gate.active && !gate.allowRequest(request.uri, request.isRedirect, request.target == GeckoSession.NavigationDelegate.TARGET_WINDOW_NEW)) stop()
                        return GeckoResult.fromValue(AllowOrDeny.ALLOW)
                    }
                    override fun onLocationChange(session: GeckoSession, url: String?, perms: MutableList<GeckoSession.PermissionDelegate.ContentPermission>, hasUserGesture: Boolean) {
                        if (gate.active && !gate.allowLocation(url)) stop()
                    }
                }
                session.progressDelegate = object : GeckoSession.ProgressDelegate {
                    override fun onPageStart(session: GeckoSession, url: String) { if (gate.active && !gate.allowLocation(url)) stop() }
                    override fun onPageStop(session: GeckoSession, success: Boolean) { if (!success && gate.active) stop() }
                }
                try {
                    channel.attach(GeckoHost.collectorExtension(context))
                    assertTrue(background.awaitPort(10_000))
                    session.open(GeckoHost.runtime(context)); host!!.geckoView.setSession(session); session.setActive(true)
                    val target = server.url(groupPath, "response-load-scroll")
                    session.loadUri(target); assertTrue(channel.awaitPort(30_000)); delay(1_000)
                    gate.begin(target)
                    val report = ResponseLoadRunner(background).run(session,channel,target,FIXTURE_GROUP_ID,12_000,autoScrollConsent=true,fastScrollConsent=true,
                        alive={gate.active},willLoad={gate.willLoad()})
                    assertFalse("unexpected native STOP: $report", unexpectedStop)
                    Log.i("GeckoPocTest", "RESPONSE_COMBINED $report")
                    assertTrue("beacon not classified: $report", report?.contains("Ping=1")==true || report?.contains("Beacon=1")==true)
                    assertTrue("beacon endpoint not counted: $report", report?.contains("AjaxBz=1")==true)
                    assertTrue("beacon must not be read: $report", report?.contains("responseFiltered: 2")==true)
                    for (field in listOf("responseLoadMode: 1","responseLoadNavigation: 1","responseLoadVerified: 1","responseAutoScroll: 1","responseFastScroll: 1","responseScrollCadenceMs: 500","responseScrollSteps: 5","responseScrollMoves: 5","responseExactIds: 2","responseCompleted: 2"))
                        assertTrue("missing $field: $report", report?.contains(field)==true)
                    gate.cancel()
                    val started = android.os.SystemClock.elapsedRealtime()
                    gate.begin(target)
                    launch { delay(1_500); gate.cancel(); channel.abortResponseDiagnosis(); background.abortResponses() }
                    assertNull(ResponseLoadRunner(background).run(session,channel,target,FIXTURE_GROUP_ID,25_000,autoScrollConsent=true,
                        alive={gate.active},willLoad={gate.willLoad()}))
                    assertTrue("abort waited for deadline", android.os.SystemClock.elapsedRealtime()-started<8_000)
                    delay(300); gate.begin(target)
                    val clean = ResponseLoadRunner(background).run(session,channel,target,FIXTURE_GROUP_ID,4_000,
                        alive={gate.active},willLoad={gate.willLoad()})
                    assertFalse(unexpectedStop)
                    assertTrue("clean=$clean", clean?.contains("responseExactIds: 1")==true)
                    assertTrue(clean?.contains("responseAutoScroll: 0")==true)
                    assertTrue(clean?.contains("responseScrollSteps: 0")==true)
                    assertFalse(clean.orEmpty().contains("PRIVATE"))
                } finally { gate.cancel(); background.abortResponses(); channel.close(); host!!.geckoView.releaseSession(); session.close(); server.close() }
            } } }
        }
    }

    @Test fun beaconTransportNoGoDespiteNonEmptyHttpControl() {
        ActivityScenario.launch(GeckoTestHostActivity::class.java).use { scenario ->
            var host: GeckoTestHostActivity? = null
            scenario.onActivity { host = it }
            runBlocking { withTimeout(120_000) { withContext(Dispatchers.Main) {
                val server = LoopbackFixtureServer { name -> runCatching { context.assets.open(name).bufferedReader().use { it.readText() } }.getOrNull() }
                val session = GeckoSession(GeckoSessionSettings.Builder().build())
                val channel = CollectorChannel(session, fixtureMode = true)
                val background = GeckoHost.background
                try {
                    channel.attach(GeckoHost.collectorExtension(context));assertTrue(background.awaitPort(10_000))
                    session.open(GeckoHost.runtime(context));host!!.geckoView.setSession(session);session.setActive(true)
                    // Independent HTTP control: the exact Beacon endpoint really serves a non-empty fixture body.
                    val control = withContext(Dispatchers.IO) { java.net.URL(server.url("/ajax/beacon/","response-beacon-data")).readBytes() }
                    assertTrue("fixture server returned no content", control.size > 200)
                    assertTrue(String(control,Charsets.UTF_8).contains("550000000000005"))
                    Log.i("GeckoPocTest","BEACON_HTTP_CONTROL bytes=${control.size}")
                    val target = server.url(groupPath,"response-beacon")
                    session.loadUri(target);assertTrue(channel.awaitPort(30_000));delay(1_000)
                    val passive = ResponseLoadRunner(background).run(session,channel,target,FIXTURE_GROUP_ID,4_000,alive={true},willLoad={})
                    assertTrue("passive=$passive",passive?.contains("Beacon=1")==true)
                    assertTrue(passive?.contains("Read=0, Filtered=0, Completed=0, Bytes=0, NoData=0")==true)
                    assertTrue(passive?.contains("responseExactIds: 0")==true)
                    val report = ResponseLoadRunner(background).run(session,channel,target,FIXTURE_GROUP_ID,4_000,beaconConsent=true,alive={true},willLoad={})
                    Log.i("GeckoPocTest","BEACON_RESPONSE $report")
                    assertTrue("report=$report",report?.contains("Read=1, Filtered=1, Completed=1, Bytes=0, NoData=1")==true)
                    // A non-empty endpoint is independently proved above. Gecko Beacon still delivers ZERO bytes.
                    // This is a negative transport regression, NOT an empty-response or parser success claim.
                    assertTrue(report?.contains("responseExactIds: 0")==true)
                    assertTrue(report?.contains("responseCompleted: 1")==true)
                    assertFalse(report.orEmpty().contains("PRIVATE"));assertFalse(report.orEmpty().contains("550000000000005"))
                    val emptyTarget=server.url(groupPath,"response-beacon-empty")
                    session.loadUri(emptyTarget);delay(1_000);assertTrue(channel.awaitPort(30_000))
                    val empty=ResponseLoadRunner(background).run(session,channel,emptyTarget,FIXTURE_GROUP_ID,4_000,beaconConsent=true,alive={true},willLoad={})
                    Log.i("GeckoPocTest","BEACON_EMPTY $empty")
                    assertTrue("empty=$empty",empty?.contains("Read=1, Filtered=1, Completed=1, Bytes=0, NoData=1")==true)
                    assertTrue(empty?.contains("BEACON BEZ DOSTARCZONYCH BAJTÓW")==true)
                    assertTrue(empty?.contains("responseExactIds: 0")==true)
                } finally {background.abortResponses();channel.close();host!!.geckoView.releaseSession();session.close();server.close()}
            } } }
        }
    }

    @Test fun compactPocLayoutGivesBrowserMostOfScreenAndKeepsToolsOutsideViewport() {
        ActivityScenario.launch(PocActivity::class.java).use { scenario ->
            runBlocking { delay(1_000) }
            var browserHeight = 0
            scenario.onActivity { activity ->
                val root = activity.findViewById<android.view.ViewGroup>(android.R.id.content).findViewWithTag<android.view.ViewGroup>("poc.root")
                val browser = root.findViewWithTag<android.view.View>("poc.browser")
                val usable = root.height-root.paddingTop-root.paddingBottom
                browserHeight=browser.height
                Log.i("GeckoPocTest","POC_VIEWPORT browser=${browser.height} usable=$usable ratio=${browser.height.toDouble()/usable}")
                assertTrue("browser too small: ${browser.height}/$usable",usable>0 && browser.height>=usable*0.70)
                assertEquals(3,root.childCount)
                assertNull(root.findViewWithTag<android.view.View>("poc.tool.scan"))
                assertFalse(activity.diagnosticsDialog!!.isShowing)
                root.findViewWithTag<android.widget.Button>("poc.tool.tools").performClick()
            }
            runBlocking { delay(300) }
            scenario.onActivity { activity ->
                val dialog=activity.diagnosticsDialog!!
                assertTrue(dialog.isShowing)
                val panel=dialog.window!!.decorView
                assertFalse(panel.findViewWithTag<android.widget.Button>("poc.tool.scan").isEnabled)
                assertFalse(panel.findViewWithTag<android.widget.Button>("poc.tool.document").isEnabled)
                assertFalse(panel.findViewWithTag<android.widget.Button>("poc.tool.mainTransport").isEnabled)
                assertFalse(panel.findViewWithTag<android.widget.Button>("poc.tool.sharedLink").isEnabled)
                val fast=panel.findViewWithTag<android.widget.CheckBox>("poc.fastScroll")
                assertFalse(fast.isChecked);fast.isChecked=true
                val root=activity.findViewById<android.view.ViewGroup>(android.R.id.content)
                assertEquals(browserHeight,root.findViewWithTag<android.view.View>("poc.browser").height)
                dialog.dismiss()
            }
            scenario.recreate();runBlocking { delay(600) }
            scenario.onActivity { activity ->
                assertFalse(activity.diagnosticsDialog!!.isShowing)
                activity.findViewById<android.view.ViewGroup>(android.R.id.content).findViewWithTag<android.widget.Button>("poc.tool.tools").performClick()
                assertFalse(activity.diagnosticsDialog!!.window!!.decorView.findViewWithTag<android.widget.CheckBox>("poc.fastScroll").isChecked)
                activity.diagnosticsDialog!!.dismiss()
            }
        }
    }

}
