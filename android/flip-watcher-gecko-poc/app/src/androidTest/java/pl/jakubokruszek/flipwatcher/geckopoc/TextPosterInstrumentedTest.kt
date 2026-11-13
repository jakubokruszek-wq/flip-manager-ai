package pl.jakubokruszek.flipwatcher.geckopoc
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
@RunWith(AndroidJUnit4::class)
class TextPosterInstrumentedTest {
    private val context:Context=ApplicationProvider.getApplicationContext()
    @Test fun greenOffMarketAndStoryMessageKeepFieldsOwnTextAndActualPreviewPixels()=runBlocking {
        val path="/groups/$FIXTURE_GROUP_ID/"
        val server=LoopbackFixtureServer(pages=mapOf(path to "desktop-green-sale-posters")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
        try {
            val saved=BackgroundWatcherScan(context).runFixture("http://127.0.0.1:${server.port}$path"){true}
            val green=checkNotNull(saved.rows.find{it.postId=="1655103482946827"})
            assertEquals("SELL_PROPERTY",green.intent);assertEquals(260000.0,green.price);assertEquals(37.64,green.area)
            val body=checkNotNull(saved.postTexts[green.postId]);assertTrue(body.contains("Tatrzańska"));assertFalse(body.contains("FOREIGN COMMENT"))
            for(id in listOf("1655103482946827","1655103482946828")){
                assertTrue("Actual poster pixels required for $id: ${saved.captureStats}",saved.photos.any{it.postId==id&&it.jpeg.isNotEmpty()})
                val row=checkNotNull(saved.rows.find{it.postId==id})
                assertNull(OfferQuality.reason(row,saved.photos.count{it.postId==id}))
            }
        }finally{server.close()}
    }
}
