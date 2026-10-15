package pl.jakubokruszek.flipcollector.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class OfflineTestProfileTest {
    private val origin = "https://watcher-test.example.org"
    private val now = 1800000000000L
    private fun value() = JSONObject().put("version",1).put("dataMode","OFFLINE_TEST").put("origin",origin)
        .put("deviceId","00000000-0000-4000-8000-000000000001").put("deviceToken","a".repeat(43)).put("expiresAt",now+3600_000)
    @Test fun remoteProfileIsBoundToApprovedOriginAndNeverPrintsKey() {
        val profile=OfflineTestProfile.parse(value().toString(),origin,now)
        assertEquals(origin,profile.credentials.baseUrl)
        assertFalse(profile.toString().contains("a".repeat(43)))
        assertFalse(profile.credentials.toString().contains("a".repeat(43)))
        assertThrows(IllegalArgumentException::class.java) { OfflineTestProfile.parse(value().toString(),"https://other.example.org",now) }
        assertThrows(IllegalArgumentException::class.java) { OfflineTestProfile.parse(value().toString(),"",now) }
    }
    @Test fun remoteProfileRejectsProductionModeTokensAndExpiredOrLongLivedConfiguration() {
        for (patch in listOf(value().put("dataMode","LIVE"), value().put("deviceToken","isolated-ci-device-token"),
            value().put("expiresAt",now),value().put("expiresAt",now+8*86400_000L),value().put("deviceId","bad-id"))) {
            assertThrows(IllegalArgumentException::class.java) { OfflineTestProfile.parse(patch.toString(),origin,now) }
        }
        for (url in listOf("https://flip-manager-ai.vercel.app","https://project.supabase.co","http://watcher-test.example.org","https://localhost"))
            assertThrows(IllegalArgumentException::class.java) { OfflineTestProfile.parse(value().put("origin",url).toString(),url,now) }
    }
    @Test fun expirationIsCheckedAgainBeforeNetworkAndProductionGateRemainsClosed() {
        var clock=now
        val profile=OfflineTestProfile.parse(value().toString(),origin,now)
        val client=SignedCollectorClient(profile.credentials,LiveCollectionGate(false,false),nowMillis={clock},metadataEnabled=true,dataMode="OFFLINE_TEST",offlineTestProfile=profile)
        clock=profile.expiresAt
        assertThrows(IllegalArgumentException::class.java) { client.sources() }
        assertThrows(LiveCollectionDisabledException::class.java) { LiveCollectionGate(false,false).check() }
    }
}
