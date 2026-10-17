package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScanProtocolTest {
    private val request = ScanRequest(nonce = "n-1")
    private val group = PocPolicy.APPROVED_GROUP_ID

    private fun post(id: String, permalink: String = ScanProtocol.canonicalPermalink(group, id)) =
        JSONObject().put("postId", id).put("permalink", permalink).put("idSource", "DOM_LINK")

    private fun reply(status: String = "OK", vararg posts: JSONObject, nonce: String = "n-1") = JSONObject()
        .put("type", "scanResult").put("nonce", nonce).put("status", status)
        .put("posts", JSONArray(posts.toList())).put("diagnostics", JSONObject().put("visibleCards", 3)).put("scrolls", 0)

    @Test fun `valid ids pass with their canonical permalink`() {
        val report = ScanProtocol.parseScanResult(reply("OK", post("1000000000001"), post("1000000000002")), request)
        assertEquals(ScanStatus.OK, report.status)
        assertEquals(listOf("1000000000001", "1000000000002"), report.posts.map { it.postId })
        assertEquals(0, report.rejectedByApp)
        assertEquals(3, report.diagnostics["visibleCards"])
    }

    @Test fun `bad ids, foreign permalinks and duplicates are rejected`() {
        val report = ScanProtocol.parseScanResult(reply(
            "OK",
            post("1000000000001"),
            post("1000000000001"),
            post("abc"),
            post("123"),
            post("1000000000003", "https://www.facebook.com/groups/999/posts/1000000000003/"),
            post("1000000000004", "https://www.facebook.com/groups/$group/posts/1000000000004/?x=1"),
            post("1000000000005", "https://evil.example/groups/$group/posts/1000000000005/"),
        ), request)
        assertEquals(listOf("1000000000001"), report.posts.map { it.postId })
        assertEquals(6, report.rejectedByApp)
    }

    @Test fun `never more than 20 posts`() {
        val many = (0 until 35).map { post((2000000000000L + it).toString()) }.toTypedArray()
        val report = ScanProtocol.parseScanResult(reply("OK", *many), request.copy(maxPosts = 50))
        assertEquals(20, report.posts.size)
        assertEquals(15, report.rejectedByApp)
    }

    @Test fun `a stop status never carries posts`() {
        for (status in listOf("CHECKPOINT", "CAPTCHA", "LOGIN_REQUIRED", "GROUP_UNAVAILABLE", "WRONG_GROUP", "NAVIGATED_AWAY")) {
            val report = ScanProtocol.parseScanResult(reply(status, post("1000000000001")), request)
            assertEquals(ScanStatus.valueOf(status), report.status)
            assertTrue(report.posts.isEmpty())
            assertTrue(report.status.haltsAutomation)
        }
    }

    @Test fun `OK without valid posts becomes NO_POSTS`() {
        assertEquals(ScanStatus.NO_POSTS, ScanProtocol.parseScanResult(reply("OK", post("x")), request).status)
    }

    @Test fun `wrong nonce, type, unknown or app-only status and garbage are protocol errors`() {
        assertEquals(ScanStatus.PROTOCOL_ERROR, ScanProtocol.parseScanResult(reply(nonce = "other"), request).status)
        assertEquals(ScanStatus.PROTOCOL_ERROR, ScanProtocol.parseScanResult(reply().put("type", "probeResult"), request).status)
        assertEquals(ScanStatus.PROTOCOL_ERROR, ScanProtocol.parseScanResult(reply("PWNED"), request).status)
        assertEquals(ScanStatus.PROTOCOL_ERROR, ScanProtocol.parseScanResult(reply("TIMEOUT"), request).status)
        assertEquals(ScanStatus.PROTOCOL_ERROR, ScanProtocol.parseScanResult("not json", request).status)
        assertEquals(ScanStatus.PROTOCOL_ERROR, ScanProtocol.parseScanResult(42, request).status)
        assertEquals(ScanStatus.PROTOCOL_ERROR, ScanProtocol.parseScanResult(null, request).status)
    }

    @Test fun `oversized messages are refused`() {
        val huge = "x".repeat(ScanProtocol.MAX_MESSAGE_CHARS + 1)
        assertNull(ScanProtocol.asJson(huge))
        assertNull(ScanProtocol.asJson(JSONObject().put("pad", huge)))
    }

    @Test fun `request is clamped to the POC limits`() {
        val json = ScanRequest(nonce = "a", maxPosts = 99, scrolls = 50).toJson()
        assertEquals(20, json.getInt("maxPosts"))
        assertEquals(5, json.getInt("scrolls"))
        assertEquals(false, json.getBoolean("allowLoopback"))
        assertEquals(group, json.getString("groupId"))
    }

    @Test fun `probe carries only counts and location`() {
        val probe = ScanProtocol.parseProbe(JSONObject().put("host", "m.facebook.com").put("path", "/login/").put("forms", 1).put("inputs", 3).put("passwordInputs", 1).put("value", "secret"))!!
        assertEquals(1, probe.forms)
        assertEquals(1, probe.passwordInputs)
        assertTrue(!probe.toString().contains("secret"))
    }

    @Test fun `the independently approved slug accepts only its exact canonical permalinks`() {
        val oldGroupPost = post("1000000000001", "https://www.facebook.com/groups/402796264871862/posts/1000000000001/")
        val otherGroupPost = post("1000000000003", "https://www.facebook.com/groups/1350200629551011/posts/1000000000003/")
        val validPost = post("1000000000002")
        val report = ScanProtocol.parseScanResult(reply("OK", oldGroupPost, validPost, otherGroupPost), request)
        assertEquals(listOf("1000000000002"), report.posts.map { it.postId })
        assertEquals(2, report.rejectedByApp)
        assertEquals("https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/1000000000002/", report.posts.single().permalink)
    }

    @Test fun `request carries only the given verified aliases`() {
        assertEquals(0, ScanRequest(nonce = "a").toJson().getJSONArray("aliases").length())
        assertEquals("s", ScanRequest(nonce = "a", aliases = listOf("s")).toJson().getJSONArray("aliases").getString(0))
    }

    @Test fun `group probe keeps only numeric ids and a safe segment`() {
        val json = JSONObject().put("group", JSONObject().put("segment", "lodzsprzedazzakupwynajem").put("ids", JSONArray()
            .put(JSONObject().put("id", group).put("source", "al:android:url"))
            .put(JSONObject().put("id", "abc").put("source", "al:ios:url"))))
        val (segment, hits) = ScanProtocol.parseGroupProbe(json)!!
        assertEquals("lodzsprzedazzakupwynajem", segment)
        assertEquals(listOf(GroupIdHit(group, "al:android:url")), hits)
        val bad = ScanProtocol.parseGroupProbe(JSONObject().put("group", JSONObject().put("segment", "../x")))!!
        assertEquals(null, bad.first)
    }
}
