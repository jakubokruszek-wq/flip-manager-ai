package pl.jakubokruszek.flipwatcher.geckopoc

import android.graphics.Bitmap
import android.view.ViewGroup
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters

/** CI runs the two phases in separate instrumentations with am force-stop between them. */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class ArchiveProcessInstrumentedTest {
    private val context get()=InstrumentationRegistry.getInstrumentation().targetContext
    private fun row()=DesktopRow("550000000000077","https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/550000000000077/","DOM",349000.0,"EXPLICIT_TOTAL",65.0,3,"Śródmieście",null,null,"SELL_PROPERTY",true,1)
    @Test fun a_seed(){
        ArchiveTestSupport.clear(context)
        val bitmap=Bitmap.createBitmap(12,12,Bitmap.Config.ARGB_8888).apply{eraseColor(android.graphics.Color.RED)}
        val photos=try{listOf(ResultArchive.photo(row().postId,0,false,bitmap),ResultArchive.photo(row().postId,0,true,bitmap))}finally{bitmap.recycle()}
        assertTrue(ResultArchive(context).save(SavedResult(123456789L,listOf(row()),listOf(row().copy(price=348000.0)),photos)))
    }
    @Test fun b_restore(){
        val saved=ResultArchive(context).load()!!
        assertEquals(listOf(row()),saved.rows);assertEquals(348000.0,saved.ocr.single().price!!,0.0)
        assertEquals(2,saved.photos.size);assertTrue(saved.photos.any{it.crop});assertTrue(saved.photos.any{!it.crop})
        try{ActivityScenario.launch(PocActivity::class.java).use{scenario->
            ArchiveTestSupport.drain(context)
            scenario.onActivity{a->
                val root=a.findViewById<ViewGroup>(android.R.id.content)
                assertNotNull(root.findViewWithTag<android.view.View>("poc.offer.card.${row().postId}"))
                assertNotNull(root.findViewWithTag<android.view.View>("poc.offer.photo.${row().postId}.0"))
                assertNotNull(root.findViewWithTag<android.view.View>("poc.ocr.result.${row().postId}"))
                assertNull(PocActivity::class.java.getDeclaredField("session").apply{isAccessible=true}.get(a))
            }
        }}finally{ArchiveTestSupport.clear(context)}
    }
}
