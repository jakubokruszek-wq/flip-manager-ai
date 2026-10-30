package pl.jakubokruszek.flipwatcher.geckopoc
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class VisiblePostsProtocolTest {
    private fun reply(): JSONObject = JSONObject().put("type", "visiblePostsResult").put("nonce", "fresh")
        .put("status", "GROUP_OK").put("counts", JSONObject().also { c -> VisiblePostsProtocol.keys.forEach { c.put(it, 0) } })
    @Test fun countsOnly() { assertNotNull(VisiblePostsProtocol.report(reply(), "fresh")) }
    @Test fun staleSessionRejected() { assertNull(VisiblePostsProtocol.report(reply(), "old")) }
    @Test fun stopRejected() { assertNull(VisiblePostsProtocol.report(reply().put("status", "STOP"), "fresh")) }
    @Test fun rawDataRejected() { assertNull(VisiblePostsProtocol.report(reply().put("text", "private"), "fresh")) }
    @Test fun invalidCountsRejected() { val r = reply(); r.getJSONObject("counts").put("candidates", 21); assertNull(VisiblePostsProtocol.report(r, "fresh")) }
}
