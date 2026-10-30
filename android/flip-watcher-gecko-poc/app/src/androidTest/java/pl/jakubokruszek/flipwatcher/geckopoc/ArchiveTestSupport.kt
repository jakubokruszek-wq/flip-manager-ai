package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*

object ArchiveTestSupport {
    fun drain(context:Context){repeat(2){val latch=CountDownLatch(1);ResultArchiveJobs.load(context){latch.countDown()};assertTrue(latch.await(15,TimeUnit.SECONDS));androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().waitForIdleSync()}}
    fun clear(context:Context){val latch=CountDownLatch(1);var ok=false;ResultArchiveJobs.delete(context){ok=it;latch.countDown()};assertTrue(latch.await(15,TimeUnit.SECONDS));assertTrue(ok)}
}
