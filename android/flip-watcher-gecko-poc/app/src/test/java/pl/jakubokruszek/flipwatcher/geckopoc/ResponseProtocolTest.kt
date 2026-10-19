package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ResponseProtocolTest {
    private fun reply() = JSONObject().put("type", "responseDiagnosisResult").put("nonce", "fresh").put("status", "OK").put("counts", JSONObject().apply { ResponseProtocol.keys.forEach { put(it, 0) } })
    @Test fun onlyCountsAreDisplayed() { assertTrue(ResponseProtocol.report(reply(), "fresh")!!.startsWith("ODPOWIEDZI 0.2.9")) }
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
}
