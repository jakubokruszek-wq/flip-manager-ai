package pl.jakubokruszek.flipwatcher.geckopoc
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import org.json.JSONArray
class JoinedGroupsProtocolTest {
    private val nonce="12345678-1234-1234-1234-123456789012"
    private fun reply()=JSONObject().put("type","joinedGroupsResult").put("nonce",nonce).put("status","OK").put("reason","DONE").put("groups",JSONArray().put(JSONObject().put("url","https://www.facebook.com/groups/123456789/").put("name","Nieruchomości Łódź"))).put("stats",JSONObject(mapOf("examined" to 2,"accepted" to 1,"namesFound" to 1,"rejected" to 0,"duplicates" to 1,"scrollSteps" to 2,"scrollMoves" to 1,"stabilized" to 1,"pageVisible" to 1)))
    @Test fun exactDirectoryAndStrictMetadataOnly(){
        assertTrue(JoinedGroupsProtocol.page(JoinedGroupsProtocol.URL))
        for(url in listOf("https://www.facebook.com/groups/feed/","https://evil.test/groups/joins/","https://www.facebook.com:443/groups/joins/","https://www.facebook.com/groups/joins/#x"))assertFalse(url,JoinedGroupsProtocol.page(url))
        val result=checkNotNull(JoinedGroupsProtocol.parse(reply(),nonce));assertEquals(1,result.groups.size);assertFalse(result.body().contains("nonce"))
        assertNull(JoinedGroupsProtocol.parse(reply().put("text","private"),nonce));assertNull(JoinedGroupsProtocol.parse(reply().put("nonce","other"),nonce))
        val bad=reply();bad.getJSONArray("groups").getJSONObject(0).put("url","https://www.facebook.com/groups/joins/");assertNull(JoinedGroupsProtocol.parse(bad,nonce))
    }
    @Test fun managerHandoffNeverAllowsCallerSuppliedOriginOrQuerySecret(){
        val token=nonce+"."+"a".repeat(64)
        val body=JSONObject().put("token",token).put("expiresAt","2026-11-05T11:00:00Z")
        val url=WatcherDiscoveryUpload.handoff(body.toString());assertTrue(url.startsWith(WatcherLink.ORIGIN+"/facebook-watcher/groups#group-discovery="));assertFalse(url.contains("?"))
        assertTrue(runCatching{WatcherDiscoveryUpload.handoff(body.put("url","https://evil.test").toString())}.isFailure)
    }
    @Test fun explicitDocumentContextDenialDoesNotMasqueradeAsMalformedTransport(){
        val value=JSONObject().put("type","desktopDocumentProof").put("nonce",nonce).put("documentId",JSONObject.NULL).put("timeOrigin",JSONObject.NULL)
        assertTrue(DesktopProtocol.documentProofDenied(value,nonce));assertNull(DesktopProtocol.documentProof(value,nonce));assertFalse(DesktopProtocol.documentProofDenied(value,"other"))
        value.put("documentId",nonce).put("timeOrigin",1000.0);assertFalse(DesktopProtocol.documentProofDenied(value,nonce));assertNotNull(DesktopProtocol.documentProof(value,nonce))
    }
}
