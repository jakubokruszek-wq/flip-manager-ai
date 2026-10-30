package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkControlTest {
    private fun counts(vararg pairs: Pair<String, Int>) = mapOf("backgroundAnswered" to 1) + pairs

    @Test fun `classification of the control counters`() {
        assertEquals(ControlStatus.LISTENER_OK, NetworkControl.classify(counts("controlTab" to 5)))
        assertEquals(ControlStatus.WRONG_TAB, NetworkControl.classify(counts("controlOtherTab" to 4)))
        assertEquals(ControlStatus.WRONG_TAB, NetworkControl.classify(counts("controlNoTab" to 2)))
        assertEquals(ControlStatus.LISTENER_NOT_OBSERVED, NetworkControl.classify(counts("netArmed" to 1)))
        assertEquals(ControlStatus.LISTENER_NOT_OBSERVED, NetworkControl.classify(counts("controlTab" to 1)))
        assertEquals(ControlStatus.TIMEOUT, NetworkControl.classify(null))
        assertEquals(ControlStatus.TIMEOUT, NetworkControl.classify(mapOf("controlTab" to 9)))
    }

    @Test fun `control reply is validated and whitelisted`() {
        val reply = JSONObject().put("type", "networkControlResult").put("nonce", "n").put("status", "DONE")
            .put("counts", JSONObject().put("controlTab", 4).put("backgroundAnswered", 1).put("url", 1).put("cookie", 7))
        val parsed = ScanProtocol.parseNetworkControl(reply, "n")!!
        assertEquals(4, parsed["controlTab"])
        assertFalse(parsed.containsKey("url"))
        assertFalse(parsed.containsKey("cookie"))
        assertNull(ScanProtocol.parseNetworkControl(reply, "other"))
        assertNull(ScanProtocol.parseNetworkControl(JSONObject(reply.toString()).put("status", "NOT_CONTROL_PAGE"), "n"))
        assertEquals("networkControl", ScanProtocol.networkControlRequest("n").getString("type"))
        assertEquals(FIXTURE_GROUP_ID, ScanProtocol.networkControlRequest("n").getString("groupId"))
        assertEquals(10_000, ScanProtocol.networkControlRequest("n", windowMs = 99_999).getInt("windowMs"))
    }

    @Test fun `every control outcome is explained and says nothing about Facebook on success`() {
        for (status in ControlStatus.entries) {
            val text = NetworkControl.describe(ControlResult(status, counts()))
            assertTrue(text.contains("Znaczenie:"))
        }
        assertTrue(NetworkControl.describe(ControlResult(ControlStatus.LISTENER_OK, counts())).contains("NIE dowodzi niczego o ruchu Facebooka"))
    }

    private fun diag(vararg pairs: Pair<String, Int>, status: String = "GROUP_OK") =
        StructureDiagnosis(status, null, ScanProtocol.STRUCTURE_FIELDS.associateWith { 0 } + pairs, emptyList())

    @Test fun `architecture verdict`() {
        assertEquals(ArchitectureDecision.INCOMPLETE, ArchitectureVerdict.decide(null, diag()).decision)
        assertEquals(ArchitectureDecision.NO_GO, ArchitectureVerdict.decide(ControlStatus.LISTENER_NOT_OBSERVED, diag("scriptExactIds" to 3)).decision)
        assertEquals(ArchitectureDecision.NO_GO, ArchitectureVerdict.decide(ControlStatus.TIMEOUT, null).decision)
        assertEquals(ArchitectureDecision.CONDITIONAL_GO, ArchitectureVerdict.decide(ControlStatus.WRONG_TAB, diag()).decision)
        assertEquals(ArchitectureDecision.INCOMPLETE, ArchitectureVerdict.decide(ControlStatus.LISTENER_OK, null).decision)
        assertEquals(ArchitectureDecision.GO, ArchitectureVerdict.decide(ControlStatus.LISTENER_OK, diag("scriptExactIds" to 2)).decision)
        assertEquals(ArchitectureDecision.NO_GO, ArchitectureVerdict.decide(ControlStatus.LISTENER_OK, diag("netTabXhr" to 12)).decision)
        assertEquals(ArchitectureDecision.CONDITIONAL_GO, ArchitectureVerdict.decide(ControlStatus.LISTENER_OK, diag("netFbcdnTab" to 30)).decision)
        assertEquals(ArchitectureDecision.CONDITIONAL_GO, ArchitectureVerdict.decide(ControlStatus.LISTENER_OK, diag("netOtherTabTotal" to 9)).decision)
        assertEquals(ArchitectureDecision.CONDITIONAL_GO, ArchitectureVerdict.decide(ControlStatus.LISTENER_OK, diag()).decision)
    }

    @Test fun `image, video and other long numbers never make a GO`() {
        // Numeric attributes and counts unrelated to exact ids must not change the verdict.
        val d = StructureDiagnosis("GROUP_OK", null, ScanProtocol.STRUCTURE_FIELDS.associateWith { 0 }, emptyList(),
            numericAttributes = listOf("data-image-id" to 390, "data-video-id" to 12, "data-comment-id" to 40))
        assertFalse(ArchitectureVerdict.decide(ControlStatus.LISTENER_OK, d).decision == ArchitectureDecision.GO)
    }
}
