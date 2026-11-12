package pl.jakubokruszek.flipwatcher.geckopoc

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class BackgroundDocumentLoadTest {
    @Test fun abortedBlankAndRedirectCanBeFollowedByTheRealDocument(){
        val load=BackgroundDocumentLoad("GROUP")
        load.started();load.stopped(false);load.failed("about:blank",1,-2)
        assertFalse(load.ready);assertNull(load.reason)
        load.started();load.stopped(true)
        assertTrue(load.ready);assertNull(load.reason)
        // A late unscoped abort cannot invalidate a subsequently proven page.
        load.stopped(false);assertTrue(load.ready)
        load.started();assertFalse(load.ready)
    }
    @Test fun loginAndContextReasonsSurviveLaterGenericLoadEvents(){
        for(reason in listOf("LOGIN_REQUIRED","CHECKPOINT","CAPTCHA","GROUP_CONTEXT_REJECTED")){
            val load=BackgroundDocumentLoad("GROUP")
            load.reject(reason);load.failed("https://www.facebook.com/login/",1,2);load.stopped(false)
            assertEquals(reason,load.reason);assertFalse(load.ready)
        }
    }
    @Test fun actualNetworkErrorKeepsItsNumericDiagnosticAndCannotBeClearedByPageStop(){
        val load=BackgroundDocumentLoad("PROFILE")
        load.failed("https://www.facebook.com/example/",Int.MIN_VALUE,Int.MAX_VALUE)
        val code=load.reason!!
        assertTrue(code.matches(Regex("[A-Z0-9_]{1,60}")))
        assertTrue(code.contains("NEG_2147483648"));assertTrue(code.contains("2147483647"))
        load.stopped(false);load.stopped(true);load.reject("PROFILE_CONTEXT_REJECTED")
        assertEquals(code,load.reason)
    }
    private fun saved()=SavedResult(1L,emptyList(),emptyList(),emptyList())
    @Test fun transientFailureRetriesExactlyOnceAndRecordsAttempts()=runBlocking {
        for(prefix in listOf("GROUP","PROFILE")){
            var attempts=0;var pauses=0;var phases=0
            val value=BackgroundLoadRetry.run(prefix,{true},{assertEquals("LOADING",it);phases++},pause={pauses++}){
                attempts++;if(attempts==1)error("${prefix}_LOAD_ERROR_C1_E2")
                saved()
            }
            assertEquals(2,attempts);assertEquals(1,pauses);assertEquals(1,phases)
            assertEquals(2,value.captureStats[prefix.lowercase()+"LoadAttempts"])
        }
    }
    @Test fun retriesDoNotLoopAndNeverRetryLoginCancellationOrParserFailures()=runBlocking {
        for(reason in listOf("GROUP_LOAD_ERROR_C1_E2","GROUP_NOT_READY","GROUP_RENDER_RETRY_FAILED","LOGIN_REQUIRED","CHECKPOINT","CAPTCHA","GROUP_CONTEXT_REJECTED","SCAN_PROTOCOL")){
            var attempts=0
            val error=runCatching{BackgroundLoadRetry.run("GROUP",{true},pause={}){attempts++;error(reason)}}.exceptionOrNull()
            assertEquals(reason,error?.message)
            assertEquals(if(reason.startsWith("GROUP_LOAD_ERROR")||reason in setOf("GROUP_NOT_READY","GROUP_RENDER_RETRY_FAILED"))2 else 1,attempts)
        }
        var attempts=0
        val error=runCatching{BackgroundLoadRetry.run("GROUP",{true},pause={}){attempts++;throw CancellationException("GROUP_LOAD_ERROR")}}.exceptionOrNull()
        assertTrue(error is CancellationException);assertEquals(1,attempts)
    }
    @Test fun disableDuringPausePreventsOpeningAnotherSession()=runBlocking {
        var live=true;var attempts=0
        runCatching{BackgroundLoadRetry.run("GROUP",{live},pause={live=false}){attempts++;error("GROUP_LOAD_ERROR")}}
        assertEquals(1,attempts)
        attempts=0
        val value=BackgroundLoadRetry.run("GROUP",{true},pause={error("Unexpected retry")}){attempts++;saved()}
        assertEquals(1,attempts);assertEquals(1,value.captureStats["groupLoadAttempts"])
    }
}
