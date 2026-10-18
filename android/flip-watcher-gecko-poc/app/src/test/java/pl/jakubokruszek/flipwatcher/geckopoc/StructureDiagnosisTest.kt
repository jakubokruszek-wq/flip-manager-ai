package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StructureDiagnosisTest {
    private fun reply(nonce: String = "n", status: String = "GROUP_OK", verdict: String = "EXACT_IDS_AVAILABLE", counters: JSONObject = JSONObject(), names: JSONArray = JSONArray()) =
        JSONObject().put("type", "structureDiagnosisResult").put("nonce", nonce).put("status", status)
            .put("verdict", verdict).put("counters", counters).put("attributeNames", names)

    @Test fun `request names the approved group and fixture mode`() {
        val json = ScanProtocol.structureDiagnosisRequest("n")
        assertEquals("structureDiagnosis", json.getString("type"))
        assertEquals(PocPolicy.APPROVED_GROUP_ID, json.getString("groupId"))
        assertFalse(json.getBoolean("allowLoopback"))
    }

    @Test fun `only whitelisted counters survive, clamped`() {
        val counters = JSONObject().put("netExactIds", 3).put("anchors", 5).put("postText", 77).put("secretToken", 9).put("mutAddedTotal", 5_000_000).put("images", -4)
        val d = ScanProtocol.parseStructureDiagnosis(reply(counters = counters), "n")!!
        assertEquals(3, d.counts["netExactIds"])
        assertEquals(5, d.counts["anchors"])
        assertEquals(999_999, d.counts["mutAddedTotal"])
        assertEquals(0, d.counts["images"])
        assertFalse(d.counts.containsKey("postText"))
        assertFalse(d.counts.containsKey("secretToken"))
        assertEquals(ScanProtocol.STRUCTURE_FIELDS.toSet(), d.counts.keys)
    }

    @Test fun `wrong nonce, type or status and unknown verdicts are refused`() {
        assertNull(ScanProtocol.parseStructureDiagnosis(reply(nonce = "x"), "n"))
        assertNull(ScanProtocol.parseStructureDiagnosis(reply().put("type", "scanResult"), "n"))
        assertNull(ScanProtocol.parseStructureDiagnosis(reply(status = "OK"), "n"))
        assertNull(ScanProtocol.parseStructureDiagnosis("garbage", "n"))
        assertNull(ScanProtocol.parseStructureDiagnosis(reply(verdict = "<script>"), "n")!!.verdict)
    }

    @Test fun `attribute names must look like attribute names and values never pass`() {
        val names = JSONArray()
            .put(JSONObject().put("name", "data-mcomponent").put("count", 420))
            .put(JSONObject().put("name", "https://evil/?token=1").put("count", 1))
            .put(JSONObject().put("name", "Data-Upper").put("count", 1))
        val d = ScanProtocol.parseStructureDiagnosis(reply(names = names), "n")!!
        assertEquals(listOf("data-mcomponent" to 420), d.attributeNames)
    }

    @Test fun `report explains each verdict and never mentions starting a scan`() {
        for (verdict in ScanProtocol.STRUCTURE_VERDICTS) {
            val text = StructureReport.describe(ScanProtocol.parseStructureDiagnosis(reply(verdict = verdict), "n")!!)
            assertTrue(text.contains("Wniosek:"))
            assertTrue(text.contains("Bez skanu"))
            assertFalse(text.contains("Wniosek: brak."))
        }
        val stop = StructureReport.describe(ScanProtocol.parseStructureDiagnosis(reply(status = "CHECKPOINT"), "n")!!)
        assertFalse(stop.contains("Dokument:"))
    }

    @Test fun `request paths and numeric attributes keep only names and counts`() {
        val json = reply().put("requestPaths", JSONArray()
            .put(JSONObject().put("name", "/api").put("count", 40))
            .put(JSONObject().put("name", "/(inne)").put("count", 2))
            .put(JSONObject().put("name", "/api/graphql/?doc_id=1&token=x").put("count", 9)))
            .put("numericAttributes", JSONArray()
                .put(JSONObject().put("name", "data-image-id").put("count", 390))
                .put(JSONObject().put("name", "1234567890123").put("count", 1)))
        val d = ScanProtocol.parseStructureDiagnosis(json, "n")!!
        assertEquals(listOf("/api" to 40, "/(inne)" to 2), d.requestPaths)
        assertEquals(listOf("data-image-id" to 390), d.numericAttributes)
        val text = StructureReport.describe(d)
        assertTrue(text.contains("/api×40"))
        assertTrue(text.contains("data-image-id×390"))
    }
}
