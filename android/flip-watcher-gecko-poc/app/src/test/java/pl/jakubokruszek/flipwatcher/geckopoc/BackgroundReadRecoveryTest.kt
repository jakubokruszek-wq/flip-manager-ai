package pl.jakubokruszek.flipwatcher.geckopoc

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class BackgroundReadRecoveryTest {
    private fun saved()=SavedResult(1,emptyList(),emptyList(),emptyList())
    @Test fun lostPortAndReadDeadlineGetOnlyOneFreshAttempt()=runBlocking {
        for(reason in listOf("SCAN_PORT_LOST","SCAN_DEADLINE_READING")){
            var calls=0;var pauses=0
            val value=BackgroundLoadRetry.run("GROUP",{true},pause={pauses++}){if(++calls==1)error(reason);saved()}
            assertEquals(2,calls);assertEquals(1,pauses);assertEquals(2,value.captureStats["groupLoadAttempts"])
            calls=0
            try{BackgroundLoadRetry.run("GROUP",{true},pause={}){calls++;error(reason)};fail("Must stop after two attempts")}
            catch(e:IllegalStateException){assertEquals(reason,e.message)}
            assertEquals(2,calls)
        }
    }
    @Test fun unsafeContextsProtocolErrorsAndCancellationNeverRetry()=runBlocking {
        for(reason in listOf("SCAN_CONTEXT","SCAN_NAVIGATION","LOGIN_REQUIRED","CAPTCHA","CHECKPOINT","SCAN_PROTOCOL","PROFILE_PROTOCOL")){
            var calls=0
            try{BackgroundLoadRetry.run("GROUP",{true},pause={fail("Unsafe retry")}){calls++;error(reason)};fail("Must fail closed")}
            catch(e:IllegalStateException){assertEquals(reason,e.message)}
            assertEquals(1,calls)
        }
        var calls=0
        try{BackgroundLoadRetry.run("GROUP",{true},pause={fail("Cancelled retry")}){calls++;throw CancellationException("stop")};fail("Must propagate cancellation")}
        catch(_:CancellationException){}
        assertEquals(1,calls)
    }
}
