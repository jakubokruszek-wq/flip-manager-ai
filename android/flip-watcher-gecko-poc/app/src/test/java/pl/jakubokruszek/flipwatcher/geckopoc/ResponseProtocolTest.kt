package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ResponseProtocolTest {
    private fun reply() = JSONObject().put("type", "responseDiagnosisResult").put("nonce", "fresh").put("status", "OK").put("counts", JSONObject().apply { ResponseProtocol.keys.forEach { put(it, 0) } })
    @Test fun onlyCountsAreDisplayed() { assertTrue(ResponseProtocol.report(reply(), "fresh")!!.startsWith("ODPOWIEDZI 0.3.6")) }
    @Test fun wrongNonceTypeAndStatusAreRejected() {
        assertNull(ResponseProtocol.report(reply(), "old"))
        assertNull(ResponseProtocol.report(reply().put("type", "scanResult"), "fresh"))
        assertNull(ResponseProtocol.report(reply().put("status", "ARMED"), "fresh"))
    }
    @Test fun rawDataAndExtraKeysAreRejected() {
        assertNull(ResponseProtocol.report(reply().put("body", "private"), "fresh"))
        val r = reply(); r.getJSONObject("counts").put("postId", 123456789)
        assertNull(ResponseProtocol.report(r, "fresh"))
    }
    @Test fun missingStringFractionNegativeAndOversizeAreRejected() {
        for (value in listOf<Any>("1", 1.5, -1, 2097153)) {
            val r = reply(); r.getJSONObject("counts").put("responseBytes", value)
            assertNull(ResponseProtocol.report(r, "fresh"))
        }
        val r = reply(); r.getJSONObject("counts").remove("responseStopped")
        assertNull(ResponseProtocol.report(r, "fresh"))
    }
    @Test fun boundedCountsAndCrossFieldInvariants() {
        for ((key, value) in listOf("responseExactIds" to 21, "responseFiltered" to 9, "responseCompleted" to 1, "responseRecordsWithText" to 1, "responseArmed" to 2)) {
            val r = reply(); r.getJSONObject("counts").put(key, value)
            assertNull(ResponseProtocol.report(r, "fresh"))
        }
        val r = reply(); r.getJSONObject("counts").put("responseBytes", 2097152)
        assertNotNull(ResponseProtocol.report(r, "fresh"))
    }
    @Test fun unavailableAndStoppedAreExplicit() {
        for (status in listOf("STOP", "UNSUPPORTED", "BUSY")) assertTrue(ResponseProtocol.report(reply().put("status", status), "fresh")!!.contains(status))
    }
    @Test fun zeroRequestsAreNotReportedAsParserFailure() {
        val r = reply()
        assertTrue(ResponseProtocol.report(r, "fresh")!!.contains("BRAK ZDARZEŃ"))
        r.getJSONObject("counts").put("responseObserved", 1)
        assertTrue(ResponseProtocol.report(r, "fresh")!!.contains("BRAK POWIĄZANIA Z KARTĄ"))
        r.getJSONObject("counts").put("responseBoundTab", 1)
        assertTrue(ResponseProtocol.report(r, "fresh")!!.contains("BRAK XHR W KARCIE"))
        r.getJSONObject("counts").put("responseTabXhr", 1)
        assertTrue(ResponseProtocol.report(r, "fresh")!!.contains("BRAK BEZPIECZNEJ ODPOWIEDZI"))
    }

    @Test fun scrollCountersAreBoundedAndRequireSeparateConsentFlag() {
        for ((key, value) in listOf("responseAutoScroll" to 2, "responseScrollSteps" to 6, "responseScrollMoves" to 1, "responseScrollSteps" to 1)) {
            val r = reply(); r.getJSONObject("counts").put(key, value)
            assertNull(ResponseProtocol.report(r, "fresh"))
        }
        val r = reply(); r.getJSONObject("counts").put("responseAutoScroll", 1).put("responseScrollCadenceMs", 2000).put("responseScrollSteps", 5).put("responseScrollMoves", 4)
        assertNotNull(ResponseProtocol.report(r, "fresh"))
    }

    @Test fun loadRequiresNavigationAndSafeNewDocument() {
        val r = reply(); val c = r.getJSONObject("counts"); c.put("responseLoadMode",1)
        assertNull(ResponseProtocol.report(r,"fresh"))
        c.put("responseLoadNavigation",1); assertNull(ResponseProtocol.report(r,"fresh"))
        c.put("responseLoadVerified",1); assertNotNull(ResponseProtocol.report(r,"fresh"))
        c.put("responseAutoScroll",1).put("responseScrollCadenceMs",2000).put("responseScrollSteps",5).put("responseScrollMoves",5); assertNotNull(ResponseProtocol.report(r,"fresh"))
    }
    @Test fun loadCountersCannotLeakIntoManualModeOrExceedLimits() {
        for ((key,value) in listOf("responseLoadMode" to 2,"responseLoadNavigation" to 1,"responseLoadVerified" to 1,"responseQueuedBodies" to 1)) {
            val r=reply();r.getJSONObject("counts").put(key,value);assertNull(ResponseProtocol.report(r,"fresh"))
        }
        val r=reply().put("status","STOP");r.getJSONObject("counts").put("responseLoadMode",1).put("responseQueuedBodies",9)
        assertNull(ResponseProtocol.report(r,"fresh"))
    }
    @Test fun passiveTypesAndEndpointMetadataAreNumericAndDoNotImplyBodyRead() {
        val r=reply();val c=r.getJSONObject("counts")
        c.put("responseTypePing",1).put("responseDataEndpoints",1).put("responseDataPing",1).put("responseDataEligiblePing",1).put("responseAjaxBz",1)
        val report=ResponseProtocol.report(r,"fresh")!!
        assertTrue(report.contains("Ping=1"));assertTrue(report.contains("EligiblePing=1"));assertTrue(report.contains("AjaxBz=1"));assertTrue(report.contains("responseBytes: 0"))
        assertFalse(report.contains("facebook.com"));assertFalse(report.contains("/ajax/bz/"))
    }
    @Test fun passiveMetadataRejectsRawKeysAndImpossibleEligibility() {
        for (key in listOf("responseDataPing","responseDataEligiblePing","responseAjaxBz","responseDataMissingOrigin")) {
            val r=reply();r.getJSONObject("counts").put(key,1);assertNull(ResponseProtocol.report(r,"fresh"))
        }
        val r=reply();r.getJSONObject("counts").put("resourceType","private");assertNull(ResponseProtocol.report(r,"fresh"))
    }
    @Test fun beaconRequiresSeparateFlagAndLoadMode() {
        for (key in listOf("responseBeaconFiltered","responseBeaconCompleted","responseBeaconBytes","responseBeaconNoData")) {
            val r=reply();r.getJSONObject("counts").put(key,1);assertNull(ResponseProtocol.report(r,"fresh"))
        }
        val r=reply();r.getJSONObject("counts").put("responseBeaconRead",1);assertNull(ResponseProtocol.report(r,"fresh"))
    }
    @Test fun emptyBeaconIsNotReportedAsMissingXhrOrParserFailure() {
        val r=reply();val c=r.getJSONObject("counts")
        c.put("responseLoadMode",1).put("responseLoadNavigation",1).put("responseLoadVerified",1).put("responseBeaconRead",1)
        c.put("responseObserved",1).put("responseBoundTab",1).put("responseTypeBeacon",1).put("responseFiltered",1).put("responseCompleted",1)
        c.put("responseBeaconFiltered",1).put("responseBeaconCompleted",1).put("responseBeaconNoData",1)
        val report=ResponseProtocol.report(r,"fresh")!!
        assertTrue(report.contains("BEACON BEZ DOSTARCZONYCH BAJTÓW"));assertFalse(report.contains("BRAK XHR W KARCIE"))
        c.put("responseBeaconNoData",2);assertNull(ResponseProtocol.report(r,"fresh"))
    }
    @Test fun beaconBytesShareTotalBudgetAndCannotExceedIt() {
        val r=reply();val c=r.getJSONObject("counts")
        c.put("responseLoadMode",1).put("responseLoadNavigation",1).put("responseLoadVerified",1).put("responseBeaconRead",1)
        c.put("responseFiltered",1).put("responseBeaconFiltered",1).put("responseBytes",2097152).put("responseBeaconBytes",2097152)
        assertNotNull(ResponseProtocol.report(r,"fresh"));c.put("responseBytes",1);assertNull(ResponseProtocol.report(r,"fresh"))
    }
    @Test fun cadenceRequiresMatchingAutoAndSpeedFlags() {
        val r=reply();val c=r.getJSONObject("counts");c.put("responseFastScroll",1);assertNull(ResponseProtocol.report(r,"fresh"))
        c.put("responseAutoScroll",1).put("responseScrollCadenceMs",2000);assertNull(ResponseProtocol.report(r,"fresh"))
        c.put("responseScrollCadenceMs",500);assertNotNull(ResponseProtocol.report(r,"fresh"))
        c.put("responseScrollCadenceMs",250);assertNull(ResponseProtocol.report(r,"fresh"))
    }
}
