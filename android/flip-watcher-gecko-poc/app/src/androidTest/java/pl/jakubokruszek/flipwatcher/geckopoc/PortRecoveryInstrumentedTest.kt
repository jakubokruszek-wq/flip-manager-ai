package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Color
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PortRecoveryInstrumentedTest {
    private val context:Context=ApplicationProvider.getApplicationContext()
    @Test fun disconnectedPendingRequestIsCleanedBeforeOneFreshSessionReturnsItsOwnPhoto()=runBlocking {
        val path="/groups/$FIXTURE_GROUP_ID/"
        val server=LoopbackFixtureServer(pages=mapOf(path to "desktop-green-sale-posters")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
        val channels=mutableListOf<CollectorChannel>();val events=mutableListOf<String>();var disconnects=0
        try {
            val result=withTimeout(175_000){BackgroundWatcherScan(context).runFixtureWithRecovery("http://127.0.0.1:${server.port}$path",{true},
                configureChannel={attempt,channel->
                    if(attempt==2){assertEquals(listOf("open1","clean1"),events);assertFalse(channels[0].isConnected);assertNotSame(channels[0],channel)}
                    assertTrue("Only one fresh session is allowed",attempt<=2)
                    channels.add(channel);events.add("open$attempt")
                    if(attempt==1)channel.onFixtureDesktopRequest{assertTrue(channel.disconnectFixturePort());disconnects++}
                },cleaned={attempt->assertFalse(channels[attempt-1].isConnected);events.add("clean$attempt")} )}
            assertEquals(1,disconnects);assertEquals(2,channels.size);assertEquals(listOf("open1","clean1","open2","clean2"),events)
            assertEquals(2,result.captureStats["groupLoadAttempts"]);assertTrue((result.captureStats["groupRenderedFrames"]?:0)>0)
            val id="1655103482946827";val row=checkNotNull(result.rows.find{it.postId==id})
            assertEquals("SELL_PROPERTY",row.intent);assertEquals(260000.0,row.price);assertEquals(37.64,row.area)
            val text=checkNotNull(result.postTexts[id]);assertTrue(text.contains("Tatrzańska"));assertFalse(text.contains("999999"))
            val photo=checkNotNull(result.photos.firstOrNull{it.postId==id})
            val decoded=checkNotNull(BitmapFactory.decodeByteArray(photo.jpeg,0,photo.jpeg.size))
            try{assertTrue(decoded.width<=192&&decoded.height<=144);assertTrue(Color.green(decoded.getPixel(decoded.width/2,5))>60)}finally{decoded.recycle()}
        }finally{server.close()}
    }
    @Test fun repeatedRealPortLossStopsAtTwoSessionsWithoutOuterSessionMultiplication()=runBlocking {
        val path="/groups/$FIXTURE_GROUP_ID/"
        val server=LoopbackFixtureServer(pages=mapOf(path to "desktop-green-sale-posters")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
        var opened=0;var cleaned=0;var disconnected=0
        try {
            val error=runCatching{withTimeout(175_000){BackgroundWatcherScan(context).runFixtureWithRecovery("http://127.0.0.1:${server.port}$path",{true},
                configureChannel={attempt,channel->
                    assertEquals(attempt-1,cleaned);opened++
                    channel.onFixtureDesktopRequest{assertTrue(channel.disconnectFixturePort());disconnected++}
                },cleaned={cleaned++})}}.exceptionOrNull()
            assertNotNull(error);assertEquals("SCAN_PORT_LOST",error?.message)
            assertEquals(2,opened);assertEquals(2,cleaned);assertEquals(2,disconnected)
            assertTrue(SourceRetryPolicy.closeFailure("SCAN_PORT_LOST",false))
        }finally{server.close()}
    }
}
