package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import android.graphics.Bitmap
import android.util.AtomicFile
import android.view.ViewGroup
import android.widget.Button
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.*
import org.junit.Before
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SavedResultInstrumentedTest {
    private val context get()=InstrumentationRegistry.getInstrumentation().targetContext
    private fun row()=DesktopRow("550000000000099","https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/550000000000099/","DOM",319000.0,"EXPLICIT_TOTAL",42.42,2,"Polesie","Retkinia",null,"SELL_PROPERTY",true,1)
    private fun value()=SavedResult(123456789L,listOf(row()),listOf(row().copy(price=310000.0)),emptyList())
    @Before fun before(){ArchiveTestSupport.clear(context)}
    @After fun after(){ArchiveTestSupport.clear(context)}
    @Test fun independentStoreRestoresTypedFieldsOcrAndPhotosWithoutPlaintext(){
        val bitmap=Bitmap.createBitmap(12,12,Bitmap.Config.ARGB_8888).apply{eraseColor(android.graphics.Color.GREEN)}
        val photo=try{ResultArchive.photo(row().postId,0,false,bitmap)}finally{bitmap.recycle()}
        val saved=value().copy(photos=listOf(photo));assertTrue(ResultArchive(context).save(saved))
        val restored=ResultArchive(context).load()!!;assertEquals(saved.rows,restored.rows);assertEquals(saved.ocr,restored.ocr)
        assertEquals(saved.savedAt,restored.savedAt);assertArrayEquals(photo.jpeg,restored.photos.single().jpeg)
        val bytes=File(context.noBackupFilesDir,"saved-search-v1.bin").readBytes().toString(Charsets.ISO_8859_1)
        assertFalse(bytes.contains(row().postId));assertFalse(bytes.contains("Retkinia"));assertFalse(bytes.contains("facebook.com"))
    }
    @Test fun emptyOrInvalidSnapshotCannotOverwriteGoodResult(){
        val store=ResultArchive(context);assertTrue(store.save(value()))
        assertFalse(store.save(value().copy(rows=emptyList(),ocr=emptyList())))
        assertFalse(store.save(value().copy(rows=listOf(row().copy(permalink="https://example.org/")))))
        assertFalse(store.save(value().copy(ocr=listOf(row().copy(postId="550000000000098")))))
        assertEquals(value().rows,store.load()!!.rows)
    }
    @Test fun authenticatedCorruptionFailsWithoutDeletingTheFile(){
        val store=ResultArchive(context);assertTrue(store.save(value()));val file=File(context.noBackupFilesDir,"saved-search-v1.bin")
        val bytes=file.readBytes();bytes[bytes.lastIndex]=(bytes.last().toInt() xor 1).toByte();file.writeBytes(bytes)
        assertTrue(runCatching{store.load()}.isFailure);assertTrue(file.exists())
    }
    @Test fun interruptedAtomicReplacementKeepsPreviousResult(){
        val store=ResultArchive(context);assertTrue(store.save(value()))
        val file=AtomicFile(File(context.noBackupFilesDir,"saved-search-v1.bin"));file.startWrite().use{it.write(byteArrayOf(1,2,3))}
        assertEquals(value().rows,ResultArchive(context).load()!!.rows)
    }
    @Test fun queuedSaveCannotResurrectDeletedResult(){
        val images=DesktopThumbnails();val bitmap=Bitmap.createBitmap(12,12,Bitmap.Config.ARGB_8888)
        images.put(row().postId,0,bitmap)
        InstrumentationRegistry.getInstrumentation().runOnMainSync{
            ResultArchiveJobs.save(context,value().rows,value().ocr,images,replacePhotos=true){}
            images.clear()
        }
        ArchiveTestSupport.clear(context);ArchiveTestSupport.drain(context);assertNull(ResultArchive(context).load());assertTrue(bitmap.isRecycled)
    }
    @Test fun activityPauseAndRecreationRetainResultWithoutBrowserSessionOrImplicitOcr(){
        assertTrue(ResultArchive(context).save(value()))
        ActivityScenario.launch(PocActivity::class.java).use{scenario->
            ArchiveTestSupport.drain(context)
            scenario.moveToState(Lifecycle.State.CREATED);scenario.moveToState(Lifecycle.State.RESUMED);scenario.recreate();ArchiveTestSupport.drain(context)
            scenario.onActivity{a->
                val root=a.findViewById<ViewGroup>(android.R.id.content)
                root.findViewWithTag<Button>("poc.tab.offers").performClick()
                assertNotNull(root.findViewWithTag<android.view.View>("poc.offer.card.${row().postId}"))
                assertNotNull(root.findViewWithTag<android.view.View>("poc.ocr.result.${row().postId}"))
                assertNull(root.findViewWithTag<android.view.View>("poc.ocr.start"));assertNull(root.findViewWithTag<android.view.View>("poc.review.enrich"))
                val field=PocActivity::class.java.getDeclaredField("session").apply{isAccessible=true};assertNull(field.get(a))
            }
        }
    }
    @Test fun deleteButtonCancelKeepsDataConfirmRemovesItAndPreservesUnrelatedHistory(){
        assertTrue(ResultArchive(context).save(value()))
        val prefs=context.getSharedPreferences("gecko_poc",Context.MODE_PRIVATE);prefs.edit().putString("archive-test-history","keep").commit()
        try{ActivityScenario.launch(PocActivity::class.java).use{scenario->
            ArchiveTestSupport.drain(context)
            scenario.onActivity{a->
                val root=a.findViewById<ViewGroup>(android.R.id.content);root.findViewWithTag<Button>("poc.tab.offers").performClick()
                root.findViewWithTag<Button>("poc.offers.delete").performClick();assertTrue(a.deleteResultsDialog!!.isShowing)
                a.deleteResultsDialog!!.getButton(android.app.AlertDialog.BUTTON_NEGATIVE).performClick()
            }
            assertNotNull(ResultArchive(context).load())
            scenario.onActivity{a->a.askDeleteResults();a.deleteResultsDialog!!.getButton(android.app.AlertDialog.BUTTON_POSITIVE).performClick()}
            ArchiveTestSupport.drain(context);assertNull(ResultArchive(context).load())
            scenario.recreate();ArchiveTestSupport.drain(context)
            scenario.onActivity{a->assertNull(a.findViewById<ViewGroup>(android.R.id.content).findViewWithTag<android.view.View>("poc.offer.card.${row().postId}"))}
            assertEquals("keep",prefs.getString("archive-test-history",null))
        }}finally{prefs.edit().remove("archive-test-history").commit()}
    }
    @Test fun failedNewSearchKeepsTheSavedOfferVisible(){
        assertTrue(ResultArchive(context).save(value()))
        ActivityScenario.launch(PocActivity::class.java).use{scenario->
            ArchiveTestSupport.drain(context)
            scenario.onActivity{a->
                a.publishDesktop(DesktopSummary.create("ERROR",0),emptyList())
                val root=a.findViewById<ViewGroup>(android.R.id.content)
                assertNotNull(root.findViewWithTag<android.view.View>("poc.offer.card.${row().postId}"))
                assertEquals("Oferty (1)",root.findViewWithTag<Button>("poc.tab.offers").text.toString())
            }
            assertEquals(value().rows,ResultArchive(context).load()!!.rows)
        }
    }
}
