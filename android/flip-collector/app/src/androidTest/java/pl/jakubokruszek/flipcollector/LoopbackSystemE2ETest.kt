package pl.jakubokruszek.flipcollector

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.tls.HandshakeCertificates
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import pl.jakubokruszek.flipcollector.collector.*
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

/** Only the manually provisioned CI API; never accepts a production origin. */
@RunWith(AndroidJUnit4::class)
class LoopbackSystemE2ETest {
    @Test fun androidToSignedApiPostgresAndReceiptCanBeRepeatedSafely() = runBlocking {
        val args=InstrumentationRegistry.getArguments()
        val origin=args.getString("isolatedApiOrigin")
        assumeTrue("Isolated CI fixture not provisioned", origin != null)
        require(origin == "https://10.0.2.2:55441")
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        val context=instrumentation.targetContext
        val cert=instrumentation.context.assets.open("isolated-test-cert.pem").use {
            CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate
        }
        val tls=HandshakeCertificates.Builder().addTrustedCertificate(cert).build()
        val http=OkHttpClient.Builder().sslSocketFactory(tls.sslSocketFactory(),tls.trustManager).build()
        val client=SignedCollectorClient(CollectorCredentials(origin!!,"00000000-0000-4000-8000-000000000001","isolated-ci-device-token"),LiveCollectionGate(true,true),http,metadataEnabled=true,dataMode="OFFLINE_TEST")
        assertFalse(BuildConfig.LIVE_COLLECTION_ENABLED)
        assertFalse(BuildConfig.ANDROID_BACKEND_INTEGRATION_ENABLED)
        assertTrue(client.deviceStatus().getBoolean("paired"))
        val sources=client.sources()
        assertEquals(13,sources.size);assertEquals(11,sources.count { it.sourceType=="GROUP" });assertEquals(2,sources.count { it.sourceType=="PROFILE" })
        assertEquals(1,sources.count { !it.enabled })
        val job=client.claim()!!;val group=requireNotNull(job.group);assertEquals("offline-lodz",group.getString("sourceId"))
        assertNotNull(client.renewLease(job))
        val source=JSONObject().put("sourceId",group.getString("sourceId")).put("sourceType",group.getString("type")).put("sourceUrl",group.getString("url"))
        val html=instrumentation.context.assets.open("offline-source.html").bufferedReader().use { it.readText() }
        val collected=OfflineDocumentCollector(context).collect(html,source)
        val posts=collected.getJSONArray("posts")
        val health=JSONObject().put("status","HEALTHY").put("visibleCardCount",posts.length()).put("capturedPostCount",posts.length()).put("scrolls",0).put("durationMs",100).put("stopReason","NO_NEW_IDS").put("reasons",org.json.JSONArray())
        val batch=JSONObject(collected.toString()).put("collectedAt",java.time.Instant.now().toString()).put("health",health)
        val pending=client.prepareCompletion(job,batch=batch)
        val outbox=CompletionOutbox(EncryptedCompletionStorage(context));outbox.enqueue(pending);outbox.flush(client)
        assertNull(outbox.pending())
        val first=client.status(job).getJSONObject("receipt")
        val again=client.sendCompletion(pending)
        assertEquals(first.getString("completionId"),again.getString("completionId"))
        assertEquals(first.getString("status"),again.getString("status"))
        val result=again.getJSONObject("result")
        assertEquals(1,result.getInt("listingsCreated"))
        assertEquals(0,result.getInt("listingsUpdated"))
        assertEquals(posts.length(),result.getJSONObject("quality").getInt("capturedPosts"))
        assertEquals("SETTLED",client.diagnostics(job).getString("completionState"))
        http.newCall(okhttp3.Request.Builder().url(origin + "/__test/stats").build()).execute().use { response ->
            assertTrue(response.isSuccessful)
            val stats=JSONObject(response.body!!.string())
            assertEquals(1,stats.getInt("listings"));assertEquals(1,stats.getInt("completedBatches"))
        }
    }
}
