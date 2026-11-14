package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Same private page before and after the real UI pause/stop transition.
 * No account, network service, queue mutation or replacement frame proof. */
@RunWith(AndroidJUnit4::class)
class RenderLifecycleInstrumentedTest {
    private val context:Context=ApplicationProvider.getApplicationContext()
    @Test fun sameRuntimeDeliversOwnFramesBeforeAndAfterActivityBackgrounding()=runBlocking {
        val path="/groups/$FIXTURE_GROUP_ID/"
        val server=LoopbackFixtureServer(pages=mapOf(path to "desktop-green-sale-posters")){name->
            runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()
        }
        val target="http://127.0.0.1:${server.port}$path"
        val prefs=WatcherAutomation.preferences(context)
        val wasEnabled=WatcherAutomation.enabled(context)
        // Keep automatic workers out of this controlled rendering comparison.
        prefs.edit().putBoolean("enabled",false).commit()
        RenderDiagnostics.set(context,true)
        suspend fun readOwnFrame(){
            assertFalse(WatcherAutomation.uiVisible)
            val result=BackgroundWatcherScan(context).runFixture(target){!WatcherAutomation.uiVisible}
            assertTrue(checkNotNull(result.captureStats["groupAcquiredFrames"])>0)
            assertTrue(checkNotNull(result.captureStats["groupRenderedFrames"])>0)
            assertTrue(result.photos.any{it.postId=="1655103482946827"&&it.jpeg.isNotEmpty()})
        }
        try {
            readOwnFrame()
            ActivityScenario.launch(PocActivity::class.java).use{scenario->
                assertTrue(WatcherAutomation.uiVisible)
                scenario.moveToState(Lifecycle.State.CREATED)
                readOwnFrame()
                scenario.moveToState(Lifecycle.State.RESUMED)
                assertTrue(WatcherAutomation.uiVisible)
                scenario.moveToState(Lifecycle.State.CREATED)
                readOwnFrame()
            }
        } finally {
            RenderDiagnostics.set(context,false)
            prefs.edit().putBoolean("enabled",wasEnabled).commit()
            server.close()
        }
    }
}
