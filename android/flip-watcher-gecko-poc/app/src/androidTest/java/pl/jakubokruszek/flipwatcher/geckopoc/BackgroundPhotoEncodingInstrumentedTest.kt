package pl.jakubokruszek.flipwatcher.geckopoc

import android.graphics.Bitmap
import android.graphics.Color
import android.os.Looper
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class BackgroundPhotoEncodingInstrumentedTest {
    private fun row(id:String)=DesktopRow(id,WatcherGroups.configured.first().postUrl(id),"DOM",430000.0,"EXPLICIT_TOTAL",42.0,2,"Bałuty",null,null,"SELL_PROPERTY",true,1)
    private fun bitmap(width:Int,height:Int,color:Int)=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888).apply{eraseColor(color)}

    @Test fun largeOcrCropsAreRecycledBeforeEncoderWhileAllSmallJpegsStayIdentical()=runBlocking {
        val rows=listOf(row("550000000000118"),row("550000000000119"))
        val small=listOf(bitmap(192,144,Color.RED),bitmap(192,144,Color.GREEN))
        val large=listOf(bitmap(512,512,Color.BLUE),bitmap(1024,1024,Color.WHITE))
        val images=DesktopThumbnails(50)
        rows.forEachIndexed{i,r->check(images.put(r.postId,0,small[i],large[i]))}
        assertTrue(images.ocrBytes>=5*1024*1024)
        val expected=rows.mapIndexed{i,r->ResultArchive.photo(r.postId,0,false,small[i])}
        var calls=0
        try {
            val encoded=withContext(Dispatchers.Main){BackgroundPhotoEncoding.encode(rows,images){id,slot,b->
                assertNotEquals(Looper.getMainLooper(),Looper.myLooper())
                assertEquals(0,images.ocrBytes);assertTrue(large.all{it.isRecycled})
                assertTrue(rows.all{images.ocrRows(it.postId).isEmpty()})
                assertFalse(b.isRecycled);calls++
                ResultArchive.photo(id,slot,false,b)
            }}
            assertEquals(rows.size,calls);assertEquals(rows.map{it.postId},encoded.map{it.postId})
            encoded.forEachIndexed{i,p->assertEquals(0,p.slot);assertFalse(p.crop);assertArrayEquals(expected[i].jpeg,p.jpeg)}
            assertEquals(2,images.count);assertTrue(small.none{it.isRecycled})
            assertEquals(Color.RED,small[0].getPixel(0,0));assertEquals(Color.GREEN,small[1].getPixel(0,0))
        }finally{images.clear()}
        assertTrue(small.all{it.isRecycled});assertTrue(large.all{it.isRecycled})
    }
    @Test fun encoderFailureDoesNotRetainOcrOrPrematurelyRecycleTransferImage()=runBlocking {
        val row=row("550000000000120");val small=bitmap(192,144,Color.RED);val large=bitmap(1024,1024,Color.BLUE)
        val images=DesktopThumbnails(50);check(images.put(row.postId,0,small,large))
        val failure=IllegalStateException("SYNTHETIC_ENCODING_FAILURE")
        try {
            try{BackgroundPhotoEncoding.encode(listOf(row),images){_,_,b->assertTrue(large.isRecycled);assertFalse(b.isRecycled);throw failure};fail("Encoder should throw")}
            catch(error:IllegalStateException){assertSame(failure,error)}
            assertEquals(0,images.ocrBytes);assertTrue(large.isRecycled);assertFalse(small.isRecycled)
        }finally{images.clear()}
    }
    @Test fun cancellationStillWaitsForEncoderBeforeCallerRecyclesTransferImage()=runBlocking {
        val row=row("550000000000121");val small=bitmap(192,144,Color.GREEN);val large=bitmap(1024,1024,Color.WHITE)
        val images=DesktopThumbnails(50);check(images.put(row.postId,0,small,large))
        val entered=CompletableDeferred<Unit>();val release=CountDownLatch(1)
        val job=launch(Dispatchers.Main){
            try{BackgroundPhotoEncoding.encode(listOf(row),images){id,slot,b->
                assertTrue(large.isRecycled);assertFalse(b.isRecycled);entered.complete(Unit)
                check(release.await(5,TimeUnit.SECONDS)){"ENCODER_TEST_TIMEOUT"}
                assertFalse(b.isRecycled);ResultArchive.photo(id,slot,false,b)
            }}finally{images.clear()}
        }
        try {
            withTimeout(5000){entered.await()}
            job.cancel()
            assertTrue(large.isRecycled);assertFalse(small.isRecycled)
            release.countDown();withTimeout(5000){job.join()}
            assertTrue(job.isCancelled);assertTrue(small.isRecycled)
        }finally{release.countDown();job.cancel();withTimeout(5000){job.join()};images.clear()}
    }
}
