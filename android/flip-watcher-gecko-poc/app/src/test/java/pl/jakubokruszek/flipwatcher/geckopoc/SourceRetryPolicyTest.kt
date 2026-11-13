package pl.jakubokruszek.flipwatcher.geckopoc

import org.junit.Assert.*
import org.junit.Test

class SourceRetryPolicyTest {
    @Test fun dnsFailureNeverConsumesCompletionAndOnlyKnownHostErrorsPauseTheCycle(){
        for(issue in listOf("GROUP_LOAD_ERROR_C5_E37","PROFILE_LOAD_ERROR_C5_E37")){
            assertTrue(SourceRetryPolicy.pauseForNetwork(issue))
            assertFalse(SourceRetryPolicy.closeFailure(issue,false))
            assertFalse(SourceRetryPolicy.closeFailure(issue,true))
        }
        for(issue in listOf("GROUP_RENDER_RETRY_FAILED","GROUP_LOAD_ERROR_C7_E55","GROUP_LOAD_ERROR_C5_E38"))assertFalse(SourceRetryPolicy.pauseForNetwork(issue))
    }
    @Test fun missingPhotoDoesNotReplayTheWholeGroupButOtherEvidenceGetsOneRetry(){
        assertTrue(SourceRetryPolicy.closeCapture("",false))
        assertTrue(SourceRetryPolicy.closeCapture("SALE_PHOTO_MISSING",false))
        for(issue in listOf("NO_POST_EVIDENCE","SCROLL_NOT_CONFIRMED","PAGE_HIDDEN","CAPTURE_NOT_MEASURED")){
            assertFalse(issue,SourceRetryPolicy.closeCapture(issue,false))
            assertTrue(issue,SourceRetryPolicy.closeCapture(issue,true))
        }
    }
    @Test fun exhaustedFreshSessionRecoveryDoesNotCreateAnotherPairOfSessions(){
        for(prefix in listOf("GROUP","PROFILE"))for(suffix in listOf("NOT_READY","RENDER_RETRY_FAILED","LOAD_ERROR","LOAD_ERROR_C1_E2")){
            assertTrue(SourceRetryPolicy.closeFailure("${prefix}_$suffix",false))
        }
        for(issue in listOf("SOURCE_TIMEOUT","NETWORK_UNAVAILABLE","SCAN_PROTOCOL")){
            assertFalse(SourceRetryPolicy.closeFailure(issue,false))
            assertTrue(SourceRetryPolicy.closeFailure(issue,true))
        }
    }
    @Test fun loginAndPausedWorkNeverConsumeASourceCompletion(){
        for(issue in listOf("LOGIN_REQUIRED","CAPTCHA","CHECKPOINT","WAITING_FOR_BACKGROUND")){
            assertFalse(SourceRetryPolicy.closeFailure(issue,false))
            assertFalse(SourceRetryPolicy.closeFailure(issue,true))
        }
    }
}
