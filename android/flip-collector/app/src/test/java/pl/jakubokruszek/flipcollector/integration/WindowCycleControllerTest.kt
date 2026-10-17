package pl.jakubokruszek.flipcollector.integration

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class WindowCycleControllerTest {
    private class Memory : WindowCursorStorage {
        var row:WindowCursor?=null
        override fun load(windowKey:String,mode:String)=row?.takeIf { it.windowKey==windowKey&&it.mode==mode }
        override fun save(cursor:WindowCursor) { row=cursor }
    }
    private val conditions=CycleConditions(true,true,true,90,false)
    @Test fun restartContinuesThirteenSourcesIncludingOneSettledFailure()=runBlocking {
        val storage=Memory();var now=0L;val seen=mutableListOf<String>();val ids=(1..13).map { "source-$it" }
        suspend fun run(id:String):SourceSettlement { seen+=id;now+=60_000;return if(id=="source-12")SourceSettlement.SETTLED_FAILURE else SourceSettlement.SETTLED }
        val first=WindowCycleController(storage,{now}).runCycle("night","LIVE",ids,1_800_000L,{conditions},::run)
        assertEquals("CONTINUE_NEXT_CYCLE",first);assertEquals(7,seen.size)
        val second=WindowCycleController(storage,{now}).runCycle("night","LIVE",ids,1_800_000L,{conditions},::run)
        assertEquals("WINDOW_COMPLETE",second);assertEquals(13,seen.size);assertEquals(13,seen.distinct().size)
    }
    @Test fun ambiguousImportOrScreenOffDoesNotConsumeNextSource()=runBlocking {
        val storage=Memory();val controller=WindowCycleController(storage,{0L})
        assertEquals("RECONCILIATION_REQUIRED",controller.runCycle("night","LIVE",listOf("one"),100_000L,{conditions}) { SourceSettlement.RECONCILIATION_REQUIRED })
        assertTrue(storage.row!!.finished.isEmpty())
        assertEquals("SCREEN_OFF",controller.runCycle("night","LIVE",listOf("one"),100_000L,{conditions.copy(screenOn=false)}) { error("must not run") })
    }
}
