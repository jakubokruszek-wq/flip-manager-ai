package pl.jakubokruszek.flipwatcher.geckopoc

import android.graphics.Bitmap
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class GroupArchiveInstrumentedTest {
    private val context get()=InstrumentationRegistry.getInstrumentation().targetContext
    private val first=WatcherGroups.LEGACY_GROUP
    private val second="402796264871862"
    private fun row(group:String)=DesktopRow("550000000000099","https://www.facebook.com/groups/$group/posts/550000000000099/","DOM",319000.0,"EXPLICIT_TOTAL",42.42,2,"Polesie","Retkinia",null,"SELL_PROPERTY",true,1)
    @Before fun before(){PocPolicy.selectGroup(first);ResultArchive(context,first).delete();ResultArchive(context,second).delete()}
    @After fun after(){ResultArchive(context,first).delete();ResultArchive(context,second).delete();PocPolicy.selectGroup(first)}
    @Test fun samePostIdInTwoGroupsKeepsIndependentRowsPhotosAndOcr(){
        val a=ResultArchive(context,first);val b=ResultArchive(context,second)
        val bitmap=Bitmap.createBitmap(12,12,Bitmap.Config.ARGB_8888)
        val photo=try{ResultArchive.photo(row(first).postId,0,false,bitmap)}finally{bitmap.recycle()}
        assertTrue(a.save(SavedResult(1,listOf(row(first)),listOf(row(first).copy(price=310000.0)),listOf(photo))))
        PocPolicy.selectGroup(second)
        assertTrue(b.save(SavedResult(2,listOf(row(second).copy(price=400000.0)),emptyList(),emptyList())))
        assertEquals(319000.0,a.load()!!.rows.single().price!!,0.0)
        assertArrayEquals(photo.jpeg,a.load()!!.photos.single().jpeg)
        assertEquals(310000.0,a.load()!!.ocr.single().price!!,0.0)
        assertEquals(400000.0,b.load()!!.rows.single().price!!,0.0)
        assertTrue(b.load()!!.photos.isEmpty());b.delete();assertNull(b.load());assertNotNull(a.load())
    }
    @Test fun storeCapturesGroupBeforePolicySwitchAndRejectsCrossGroupRows(){
        val a=ResultArchive(context)
        PocPolicy.selectGroup(second)
        assertTrue(a.save(SavedResult(1,listOf(row(first)),emptyList(),emptyList())))
        assertFalse(a.save(SavedResult(2,listOf(row(second)),emptyList(),emptyList())))
        assertEquals(first,java.net.URI(a.load()!!.rows.single().permalink).path.split('/')[2])
        assertNull(ResultArchive(context).load())
    }
}
