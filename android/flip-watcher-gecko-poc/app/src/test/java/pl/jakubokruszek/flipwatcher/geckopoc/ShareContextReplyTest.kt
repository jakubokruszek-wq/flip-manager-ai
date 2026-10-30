package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ShareContextReplyTest {
    private val nonce="12345678-1234-1234-1234-123456789012"
    private fun reply(safe:Boolean=true,fresh:Boolean=true,complete:Boolean=true)=JSONObject().put("type","shareLinkContextResult").put("nonce",nonce).put("safe",safe).put("fresh",fresh).put("complete",complete)
    @Test fun completeLoadingAndStaleAreDistinct() {
        assertEquals(ShareContextReply.COMPLETE,ShareContextReply.parse(reply(),nonce))
        assertEquals(ShareContextReply.LOADING,ShareContextReply.parse(reply(complete=false),nonce))
        assertEquals(ShareContextReply.STALE,ShareContextReply.parse(reply(fresh=false),nonce))
    }
    @Test fun unsafeWinsEvenWhenFreshnessAndCompletenessFail() {
        assertEquals(ShareContextReply.UNSAFE,ShareContextReply.parse(reply(false,false,false),nonce))
    }
    @Test fun absentAndMalformedProtocolsCannotMasqueradeAsStaleDocument() {
        assertEquals(ShareContextReply.ABSENT,ShareContextReply.parse(null,nonce))
        val old=reply();old.remove("fresh");assertEquals(ShareContextReply.MALFORMED,ShareContextReply.parse(old,nonce))
        for(key in listOf("safe","fresh","complete"))assertEquals(ShareContextReply.MALFORMED,ShareContextReply.parse(reply().put(key,"true"),nonce))
        assertEquals(ShareContextReply.MALFORMED,ShareContextReply.parse(reply().put("nonce","old"),nonce))
        assertEquals(ShareContextReply.MALFORMED,ShareContextReply.parse(reply().put("type","scanResult"),nonce))
    }
    @Test fun additionalDataAndUntrustedFieldsAreRejected() {
        for(key in listOf("url","id","text","timeOrigin","cookie","token","consent"))
            assertEquals(ShareContextReply.MALFORMED,ShareContextReply.parse(reply().put(key,"PRIVATE"),nonce))
    }
}
