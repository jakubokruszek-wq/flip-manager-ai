package pl.jakubokruszek.flipcollector.collector

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.concurrent.TimeUnit

class AndroidBackendContractTest {
    private class Memory : CompletionStorage {
        var row: PendingCompletion? = null
        override fun load() = row
        override fun save(value: PendingCompletion?) { row = value }
    }

    @Test fun lostResponsePreservesExactBodyAndRetryUsesFreshHmacNonce() {
        val cert = HeldCertificate.Builder().commonName("localhost").addSubjectAlternativeName("localhost").build()
        val serverTls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        val clientTls = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server = MockWebServer()
        server.useHttps(serverTls.sslSocketFactory(), false)
        server.start()
        try {
            val http = OkHttpClient.Builder().sslSocketFactory(clientTls.sslSocketFactory(), clientTls.trustManager).callTimeout(3, TimeUnit.SECONDS).build()
            val client = SignedCollectorClient(CollectorCredentials(server.url("/").toString(), "mock-device", "mock-token"), LiveCollectionGate(true,true), http)
            val job = ClaimedJob("mock-job", "mock-lease", "mock-run", "SOURCE_SCAN", JSONObject())
            val pending = client.prepareCompletion(job, failure="SOURCE_UNAVAILABLE")
            val memory = Memory(); val outbox = CompletionOutbox(memory)
            outbox.enqueue(pending)
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            try { outbox.flush(client); fail("lost response must retain outbox") } catch (_: IOException) {}
            assertEquals(pending, memory.row)
            server.enqueue(MockResponse().setBody(JSONObject().put("ok",true).put("status","failed").put("completionId",pending.completionId).put("result",JSONObject.NULL).toString()))
            outbox.flush(client)
            assertNull(memory.row)
            val first=server.takeRequest(3,TimeUnit.SECONDS)!!; val second=server.takeRequest(3,TimeUnit.SECONDS)!!
            assertEquals(SignedCollectorClient.COMPLETE_PATH, first.path)
            assertEquals(pending.rawBody, first.body.readUtf8()); assertEquals(pending.rawBody, second.body.readUtf8())
            assertNotEquals(first.getHeader(CollectorSigner.NONCE_HEADER), second.getHeader(CollectorSigner.NONCE_HEADER))
            assertNull(second.getHeader("Authorization"))
            val signature=CollectorSigner.sign(CollectorSigner.signingKey("mock-token"),"POST",SignedCollectorClient.COMPLETE_PATH,pending.rawBody.toByteArray(Charsets.UTF_8),second.getHeader(CollectorSigner.TIMESTAMP_HEADER)!!,second.getHeader(CollectorSigner.NONCE_HEADER)!!)
            assertEquals(signature,second.getHeader(CollectorSigner.SIGNATURE_HEADER))
        } finally { server.shutdown() }
    }

    @Test fun completionOutboxCannotBeReplacedByCancellationOrAnotherDevice() {
        val client=SignedCollectorClient(CollectorCredentials("https://example.invalid","device","mock-token"),LiveCollectionGate(false,false))
        val job=ClaimedJob("job","lease","run","SOURCE_SCAN",null)
        val pending=client.prepareCompletion(job,cancelled=true)
        val storage=Memory(); val outbox=CompletionOutbox(storage); outbox.enqueue(pending)
        try { outbox.enqueue(client.prepareCompletion(job,failure="FAILED")); fail("cannot replace") } catch (_: IllegalStateException) {}
        assertEquals(pending,storage.row)
        assertEquals("cancelled",JSONObject(pending.rawBody).getString("status"))
        assertFalse(pending.toString().contains("lease"))
        assertFalse(pending.toString().contains("rawBody"))
    }

    @Test fun metadataAndDemoAreDisabledByDefault() {
        val client=SignedCollectorClient(CollectorCredentials("https://example.invalid","device","mock-token"),LiveCollectionGate(false,false))
        try { client.sources(); fail("metadata disabled") } catch (_: IllegalStateException) {}
        try { client.claim(); fail("live disabled") } catch (_: LiveCollectionDisabledException) {}
    }
    @Test(expected = IllegalArgumentException::class)
    fun offlineOutboxCannotTargetRemoteServer() {
        SignedCollectorClient(CollectorCredentials("https://example.invalid","device","mock-token"),LiveCollectionGate(true,true),dataMode="OFFLINE_TEST")
    }
}
