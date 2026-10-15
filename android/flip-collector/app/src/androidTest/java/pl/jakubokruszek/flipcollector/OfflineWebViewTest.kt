package pl.jakubokruszek.flipcollector

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import pl.jakubokruszek.flipcollector.collector.OfflineDocumentCollector

@RunWith(AndroidJUnit4::class)
class OfflineWebViewTest {
    @Test fun localHtmlUsesExtensionCoreAndNeverBindsAdjacentImages() = runBlocking {
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        val html=instrumentation.context.assets.open("offline-source.html").bufferedReader().use { it.readText() }
        val source=JSONObject().put("sourceType","GROUP").put("sourceId","offline-lodz").put("sourceUrl","https://www.facebook.com/groups/offline-lodz/")
        val result=OfflineDocumentCollector(instrumentation.targetContext).collect(html,source)
        val posts=result.getJSONArray("posts")
        assertEquals(4,posts.length())
        val sale=(0 until posts.length()).map { posts.getJSONObject(it) }.first { it.getString("postId")=="100000000001" }
        assertEquals("EXACT",sale.getString("identityConfidence"))
        assertEquals(1,sale.getJSONArray("media").length())
        assertEquals("200000000001",sale.getJSONArray("media").getJSONObject(0).getString("mediaId"))
        assertTrue(sale.getString("text").contains("260 tyś."))
        val uncertain=posts.getJSONObject(3)
        assertEquals("UNVERIFIED",uncertain.getString("identityConfidence"))
        assertEquals(0,uncertain.getJSONArray("media").length())
        assertFalse(BuildConfig.LIVE_COLLECTION_ENABLED)
    }
}
