package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LoadMeasurementTest {
    private fun read(vararg pairs: Pair<String, Int>, stop: String? = null) =
        LoadMeasurement.Read(LoadMeasurement.LOAD_FIELDS.associateWith { 0 } + pairs, stop, emptyList())

    private val okDom = LoadMeasurement.DOM_FIELDS.associateWith { 0 } + ("domGroupOk" to 1)

    @Test fun `status PASS, PARTIAL and FAIL`() {
        assertEquals(LoadStatus.PASS, LoadMeasurement.status(true, read("loadBound" to 1, "loadDocCompleted" to 1), okDom).status)
        val partial = LoadMeasurement.status(true, read("loadBound" to 1), okDom)
        assertEquals(LoadStatus.PARTIAL, partial.status)
        assertEquals("DOCUMENT_NOT_COMPLETED", partial.reason)
        assertEquals("DOM_STATS_UNAVAILABLE", LoadMeasurement.status(true, read("loadBound" to 1, "loadDocCompleted" to 1), null).reason)
        assertEquals("NOT_ARMED", LoadMeasurement.status(false, null, null).reason)
        assertEquals("READ_TIMEOUT", LoadMeasurement.status(true, null, null).reason)
        assertEquals("MAIN_FRAME_NOT_SEEN", LoadMeasurement.status(true, read(), okDom).reason)
        assertEquals("LOGIN", LoadMeasurement.status(true, read("loadBound" to 1, stop = "LOGIN"), okDom).reason)
        assertEquals("SESSION_CLOSED", LoadMeasurement.status(true, null, null, "SESSION_CLOSED").reason)
        assertEquals(LoadStatus.FAIL, LoadMeasurement.status(true, read("loadBound" to 1, stop = "CHECKPOINT"), okDom).status)
    }

    @Test fun `verdict from a measured load`() {
        fun v(r: LoadResult) = LoadMeasurement.verdict(r).decision
        val base = arrayOf("loadBound" to 1, "loadDocCompleted" to 1)
        assertEquals(ArchitectureDecision.GO, v(LoadMeasurement.status(true, read(*base), okDom + ("scriptExactIds" to 3))))
        assertEquals(ArchitectureDecision.NO_GO, v(LoadMeasurement.status(true, read(*base, "loadPageXhr" to 14, "loadFbcdnImage" to 90), okDom)))
        assertEquals(ArchitectureDecision.CONDITIONAL_GO, v(LoadMeasurement.status(true, read(*base, "loadPageScript" to 5), okDom + ("scriptIdKeys" to 4))))
        assertEquals(ArchitectureDecision.NO_GO, v(LoadMeasurement.status(true, read(*base, "loadPageScript" to 5), okDom)))
        assertEquals(ArchitectureDecision.INCOMPLETE, v(LoadMeasurement.status(true, read("loadBound" to 1, stop = "LOGIN"), okDom)))
        assertEquals(ArchitectureDecision.INCOMPLETE, v(LoadMeasurement.status(true, read("loadBound" to 1, stop = "CAPTCHA"), okDom)))
        assertEquals(ArchitectureDecision.INCOMPLETE, v(LoadMeasurement.status(false, null, null)))
    }

    @Test fun `API requests are separated from all requests and zero API with images is not called no traffic`() {
        val r = LoadMeasurement.status(true, read("loadBound" to 1, "loadDocCompleted" to 1, "loadPageTotal" to 3, "loadPageMainFrame" to 1, "loadPageScript" to 2,
            "loadFbcdnTotal" to 102, "loadFbcdnImage" to 102), okDom)
        assertEquals(0, LoadMeasurement.apiRequests(r.counts))
        val text = LoadMeasurement.describe(r)
        listOf("Wszystkie żądania tej karty: 105", "Żądania API/danych Facebooka (XHR/fetch, websocket, ramki, inne): 0", "NIE jest brak ruchu",
            "Nasłuch uzbrojony przed nawigacją: tak", "main_frame zatwierdzonej grupy: tak", "dokument załadowany: tak", "fbcdn.net: obrazy 102", "WERDYKT:")
            .forEach { assertTrue(it, text.contains(it)) }
    }

    @Test fun `replies are validated by nonce, type and whitelist`() {
        val reply = JSONObject().put("type", "readLoadResult").put("nonce", "n1").put("found", 1).put("stopReason", "LOGIN")
            .put("counts", JSONObject().put("loadPageXhr", 3).put("url", 5).put("cookie", 1).put("loadFbcdnImage", 9_999_999))
            .put("requestPaths", JSONArray().put(JSONObject().put("name", "/api").put("count", 3)).put(JSONObject().put("name", "/api/graphql/?doc_id=1").put("count", 1)))
        val parsed = LoadMeasurement.parseRead(reply, "n1")!!
        assertEquals(3, parsed.counts["loadPageXhr"])
        assertEquals(999_999, parsed.counts["loadFbcdnImage"])
        assertFalse(parsed.counts.containsKey("url"))
        assertFalse(parsed.counts.containsKey("cookie"))
        assertEquals("LOGIN", parsed.stopReason)
        assertEquals(listOf("/api" to 3), parsed.paths)
        assertNull(LoadMeasurement.parseRead(reply, "other"))
        assertNull(LoadMeasurement.parseRead(JSONObject(reply.toString()).put("found", 0), "n1"))
        assertNull(LoadMeasurement.parseRead(JSONObject(reply.toString()).put("stopReason", "EVIL"), "n1")!!.stopReason)
        assertTrue(LoadMeasurement.parseArmed(JSONObject().put("type", "armLoadResult").put("nonce", "a").put("armed", 1), "a"))
        assertFalse(LoadMeasurement.parseArmed(JSONObject().put("type", "armLoadResult").put("nonce", "a").put("armed", 1), "b"))
        assertEquals(30_000, LoadMeasurement.armRequest("a", "g", 999_999).getInt("windowMs"))
        assertEquals("g", LoadMeasurement.armRequest("a", "g").getJSONArray("accepted").getString(0))
    }
}
