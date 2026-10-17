package pl.jakubokruszek.flipcollector

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import pl.jakubokruszek.flipcollector.collector.*
import pl.jakubokruszek.flipcollector.watcher.android.*

/** Actual Android WebView + WebMessage listener, local HTML only, network disabled. */
@RunWith(AndroidJUnit4::class)
class LivePilotWebViewTest {
    private val source = LivePilotSource("11111111-1111-4111-8111-111111111111", "offline-lodz", "https://www.facebook.com/groups/offline-lodz/")
    private suspend fun collect(html: String) = withContext(Dispatchers.Main) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val browser = WebViewCollectorBrowser(context, LiveCollectionGate(true,true), pilotSource = source)
        browser.useLocalFixture(html)
        try {
            browser.open(source.url)
            LivePilotChannel(context,browser).collect(source)
        } finally { browser.close() }
    }
    @Test fun pinnedCoreOverOriginBoundChannelExtractsExactPostsAndRejectsAdjacentPhotos() = runBlocking {
        val html = InstrumentationRegistry.getInstrumentation().context.assets.open("offline-source.html").bufferedReader().use { it.readText() }
        val batch = collect(html)
        val posts = batch.getJSONArray("posts")
        assertEquals(4, posts.length())
        val sale = posts.getJSONObject(0)
        assertEquals("EXACT",sale.getString("identityConfidence"))
        assertEquals(1,sale.getJSONArray("media").length())
        assertEquals("200000000001",sale.getJSONArray("media").getJSONObject(0).getString("mediaId"))
        assertEquals("UNVERIFIED",posts.getJSONObject(3).getString("identityConfidence"))
        assertEquals(0,posts.getJSONObject(3).getJSONArray("media").length())
        assertEquals("SOURCE_SCAN_DATA_ONLY",batch.getString("imageMode"))
        assertFalse(BuildConfig.LIVE_COLLECTION_ENABLED)
        assertFalse(BuildConfig.LIVE_PILOT_ENABLED)
    }
    @Test fun loginStopsWithoutAnyCompletionBatch() = runBlocking {
        try { collect("<html><body><form><input type='password'></form></body></html>"); fail("expected STOP") }
        catch (error: IllegalStateException) { assertEquals("LOGIN_REQUIRED",error.message) }
    }
    @Test fun emptyGroupStopsInsteadOfInventingListing() = runBlocking {
        try { collect("<html><body>Empty</body></html>"); fail("expected STOP") }
        catch (error: IllegalStateException) { assertEquals("NO_VERIFIED_POSTS",error.message) }
    }
}
