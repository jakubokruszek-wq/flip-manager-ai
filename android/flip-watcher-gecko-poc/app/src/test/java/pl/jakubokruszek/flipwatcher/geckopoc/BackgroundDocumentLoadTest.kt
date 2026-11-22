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
        for(reason in listOf("GROUP_LOAD_ERROR_C1_E2","GROUP_NOT_READY","GROUP_RENDER_RETRY_FAILED","LOGIN_REQUIRED","CHECKPOINT","CAPTCHA","GROUP_CONTEXT_REJECTED","SCAN_PROTOCOL","SCAN_NAVIGATION","SCAN_NO_CONSENT_OR_CONTEXT","SCAN_PORT_LOST")){
            var attempts=0
            val error=runCatching{BackgroundLoadRetry.run("GROUP",{true},pause={}){attempts++;error(reason)}}.exceptionOrNull()
            assertEquals(reason,error?.message)
            assertEquals(if(reason.startsWith("GROUP_LOAD_ERROR")||reason in setOf("GROUP_NOT_READY","GROUP_RENDER_RETRY_FAILED","SCAN_PORT_LOST"))2 else 1,attempts)
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
    @Test fun groupPortRecoveryCleansThePreviousAttemptBeforeTheOnlyFreshAttempt()=runBlocking {
        val events=mutableListOf<String>();var attempts=0
        val value=BackgroundLoadRetry.run("GROUP",{true},pause={events.add("pause")}){
            val attempt=++attempts;events.add("open$attempt")
            try{if(attempt==1)error("SCAN_PORT_LOST");saved()}
            finally{events.add("close$attempt")}
        }
        assertEquals(listOf("open1","close1","pause","open2","close2"),events)
        assertEquals(2,attempts);assertEquals(2,value.captureStats["groupLoadAttempts"])
    }
    @Test fun persistentGroupPortLossStopsAfterTwoButOtherFailuresAndProfilesKeepTheirCodes()=runBlocking {
        var attempts=0;var pauses=0
        val last=IllegalStateException("SCAN_PORT_LOST")
        val error=runCatching{BackgroundLoadRetry.run("GROUP",{true},pause={pauses++}){attempts++;throw last}}.exceptionOrNull()
        assertSame(last,error);assertEquals(2,attempts);assertEquals(1,pauses)
        assertTrue(SourceRetryPolicy.closeFailure("SCAN_PORT_LOST",false))
        attempts=0
        val profile=runCatching{BackgroundLoadRetry.run("PROFILE",{true},pause={fail("Profile cannot retry group port error")}){attempts++;error("SCAN_PORT_LOST")}}.exceptionOrNull()
        assertEquals("SCAN_PORT_LOST",profile?.message);assertEquals(1,attempts)
    }
    @Test fun cancellationOrStopDuringPortRecoveryCannotOpenAnotherAttempt()=runBlocking {
        var attempts=0
        val cancellation=runCatching{BackgroundLoadRetry.run("GROUP",{true},pause={fail("Cancellation must propagate")}){attempts++;throw CancellationException("SCAN_PORT_LOST")}}.exceptionOrNull()
        assertTrue(cancellation is CancellationException);assertEquals(1,attempts)
        attempts=0;var live=true
        runCatching{BackgroundLoadRetry.run("GROUP",{live},pause={live=false}){attempts++;error("SCAN_PORT_LOST")}}
        assertEquals(1,attempts)
    }

}
