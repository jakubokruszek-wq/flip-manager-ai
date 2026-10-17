package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import android.util.Log
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

    @Test fun lazyFeedWithoutViewIsMeasured() {
        // Not an assertion on lazy loading: it records whether a session with no
        // surface keeps loading the feed (the stage C question) for the report.
        val report = scan(groupPath, "lazy-feed", scrolls = 4).report
        Log.i("GeckoPocTest", "LAZY_FEED_HEADLESS status=${report.status} posts=${report.posts.size} scrolls=${report.scrolls}")
        assertEquals(ScanStatus.OK, report.status)
        assertTrue(report.posts.size >= 5)
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
