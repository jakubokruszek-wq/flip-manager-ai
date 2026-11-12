package pl.jakubokruszek.flipwatcher.geckopoc

import org.junit.Assert.*
import org.junit.Test

class ScanSourceProgressTest {
    private val sources=setOf("first","second","profile:first")
    @Test fun firstPartialReadAdvancesProgressBeforeItsRetryIsClosed(){
        assertEquals(ScanSourceProgress(1,0,1),ScanSourceProgress.count(sources,emptySet(),setOf("first")))
        assertEquals(ScanSourceProgress(1,1,0),ScanSourceProgress.count(sources,setOf("first"),setOf("first")))
    }
    @Test fun successfulAndFailedReadsCountOnceAcrossRetries(){
        assertEquals(ScanSourceProgress(2,1,1),ScanSourceProgress.count(sources,setOf("first"),setOf("first","second")))
        assertEquals(ScanSourceProgress(2,2,0),ScanSourceProgress.count(sources,setOf("first","second"),setOf("first","second")))
    }
    @Test fun closedReceiptsPreserveAttemptedCountWhenOldReportsArePruned(){
        assertEquals(ScanSourceProgress(2,1,1),ScanSourceProgress.count(sources,setOf("first"),setOf("second")))
    }
    @Test fun profilesAreSeparateAndRemovedSourcesCannotInflateProgress(){
        assertEquals(ScanSourceProgress(2,1,1),ScanSourceProgress.count(sources,setOf("first","removed"),setOf("profile:first","removed")))
        assertEquals(ScanSourceProgress(0,0,0),ScanSourceProgress.count(emptySet(),sources,sources))
    }
}
