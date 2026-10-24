package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MainTransportProtocolTest {
    private fun reply()=JSONObject().put("type","mainTransportResult").put("nonce","fresh").put("status","OK").put("counts",JSONObject().apply { MainTransportProtocol.keys.forEach { put(it,0) };put("installed",1) })
    @Test fun onlyBoundedCountersAreAcceptedAndDisplayed() {
        val r=reply();assertTrue(MainTransportProtocol.report(r,"fresh")!!.contains("brak obsługiwanych odpowiedzi"))
        assertNull(MainTransportProtocol.report(r,"old"));assertNull(MainTransportProtocol.report(r.put("body","private"),"fresh"))
    }
    @Test fun wrongTypeStatusAndRawFieldsAreRejected() {
        assertNull(MainTransportProtocol.report(reply().put("type","scanResult"),"fresh"))
        assertNull(MainTransportProtocol.report(reply().put("status","ARMED"),"fresh"))
        val r=reply();r.getJSONObject("counts").put("postId","private");assertNull(MainTransportProtocol.report(r,"fresh"))
    }
    @Test fun badNumbersAndUninstalledSuccessFailClosed() {
        for(value in listOf<Any>("1",1.5,-1,2097153)) { val r=reply();r.getJSONObject("counts").put("bytes",value);assertNull(MainTransportProtocol.report(r,"fresh")) }
        val r=reply();r.getJSONObject("counts").put("installed",0);assertNull(MainTransportProtocol.report(r,"fresh"))
    }
    @Test fun responsePostAndScrollInvariantsAreEnforced() {
        for((key,value) in listOf("completed" to 1,"exactIds" to 21,"priceSignals" to 1,"scrollSteps" to 6,"scrollMoves" to 1)) {
            val r=reply();r.getJSONObject("counts").put(key,value);assertNull(MainTransportProtocol.report(r,"fresh"))
        }
        val r=reply();r.getJSONObject("counts").put("fetchBodies",1).put("completed",1).put("exactIds",1).put("priceSignals",1).put("scrollSteps",5).put("scrollMoves",5)
        assertTrue(MainTransportProtocol.report(r,"fresh")!!.contains("Rozpoznano rekordy"))
    }
    @Test fun stoppedOrUnsupportedResultsCannotRetainPreviousCounts() {
        for(status in listOf("STOP","UNSUPPORTED","BUSY")) {
            val r=reply().put("status",status);assertNull(MainTransportProtocol.report(r,"fresh"));r.getJSONObject("counts").put("installed",0)
            assertTrue(MainTransportProtocol.report(r,"fresh")!!.contains(status))
        }
    }
}
