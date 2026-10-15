package pl.jakubokruszek.flipcollector.collector

import okhttp3.OkHttpClient
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Expected values were produced by features/collector/protocol.ts
 * (createCollectorAuthHeaders) for the same inputs, so these tests pin the
 * Kotlin port to the server's own implementation.
 */
class CollectorSignerTest {
    private val token = "test-device-token-not-a-secret-0123456789"

    @Test
    fun signingKeyIsSha256HexOfTheToken() {
        assertEquals("bc04198ee11b2c7430e724cbc89ae338d946bad5d55cba0e4c448321c0d2659c", CollectorSigner.signingKey(token))
    }

    @Test
    fun matchesServerVectorForClaimWithLowercaseMethod() {
        val headers = CollectorSigner.headers("dev-1", token, "post", "/api/collector/android/jobs/claim", "{}".toByteArray(), 1760000000000L, "nonce-0123456789abcdef")
        assertEquals("f756826fa0408fe1f0a32c5656d7547ceca40848f9b796793ed4590a273d2195", headers[CollectorSigner.SIGNATURE_HEADER])
        assertEquals("1760000000000", headers[CollectorSigner.TIMESTAMP_HEADER])
        assertEquals("nonce-0123456789abcdef", headers[CollectorSigner.NONCE_HEADER])
        assertEquals("dev-1", headers[CollectorSigner.DEVICE_HEADER])
    }

    @Test
    fun matchesServerVectorForUtf8Body() {
        val body = "{\"jobId\":\"j-1\",\"leaseToken\":\"lease-ż\"}".toByteArray(Charsets.UTF_8)
        val headers = CollectorSigner.headers("dev-1", token, "POST", "/api/collector/jobs/heartbeat", body, 1760000000123L, "abcdefABCDEF_-0123")
        assertEquals("a97a0a88fdfc0c4a1a84c35e04472c1f3accece596c4761103f5ec875fdccfae", headers[CollectorSigner.SIGNATURE_HEADER])
    }

    @Test
    fun matchesServerVectorForEmptyBody() {
        val headers = CollectorSigner.headers("dev-1", token, "GET", "/api/collector/heartbeat", ByteArray(0), 1L, "0000000000000000")
        assertEquals("b03d5da0d6d95a1690f4be0a7c615c6e1338719d45936fc56d7e9c2ae9f58fa3", headers[CollectorSigner.SIGNATURE_HEADER])
    }

    @Test
    fun anyChangeToBodyPathOrTimestampChangesTheSignature() {
        val key = CollectorSigner.signingKey(token)
        val base = CollectorSigner.sign(key, "POST", "/api/collector/android/jobs/claim", "{}".toByteArray(), "1", "nonce-0123456789abcdef")
        assertFalse(base == CollectorSigner.sign(key, "POST", "/api/collector/android/jobs/claim", "{ }".toByteArray(), "1", "nonce-0123456789abcdef"))
        assertFalse(base == CollectorSigner.sign(key, "POST", "/api/collector/jobs/complete", "{}".toByteArray(), "1", "nonce-0123456789abcdef"))
        assertFalse(base == CollectorSigner.sign(key, "POST", "/api/collector/android/jobs/claim", "{}".toByteArray(), "2", "nonce-0123456789abcdef"))
    }

    @Test
    fun defaultNonceIsAcceptedByTheServerPattern() {
        val headers = CollectorSigner.headers("dev-1", token, "POST", "/x", ByteArray(0))
        assertTrue(Regex("^[A-Za-z0-9_-]{16,128}$").matches(headers.getValue(CollectorSigner.NONCE_HEADER)))
        assertTrue(Regex("^[a-f0-9]{64}$").matches(headers.getValue(CollectorSigner.SIGNATURE_HEADER)))
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsNonceTheServerWouldRefuse() {
        CollectorSigner.headers("dev-1", token, "POST", "/x", ByteArray(0), 1L, "short")
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsPathWithQueryString() {
        CollectorSigner.headers("dev-1", token, "POST", "/x?a=1", ByteArray(0), 1L, "0000000000000000")
    }

    @Test
    fun signedRequestCarriesExactlyTheSignedBytesAndNoToken() {
        val client = SignedCollectorClient(
            CollectorCredentials("https://example.invalid", "dev-1", token),
            LiveCollectionGate(buildAllowsLive = false, facebookSessionConsent = false),
            OkHttpClient(),
            nowMillis = { 1760000000000L },
        )
        val request = client.buildSignedPost(SignedCollectorClient.CLAIM_PATH, "{}")
        val buffer = Buffer().also { request.body!!.writeTo(it) }
        val sent = buffer.readByteArray()
        assertEquals("{}", String(sent, Charsets.UTF_8))
        val expected = CollectorSigner.sign(CollectorSigner.signingKey(token), "POST", SignedCollectorClient.CLAIM_PATH, sent, request.header(CollectorSigner.TIMESTAMP_HEADER)!!, request.header(CollectorSigner.NONCE_HEADER)!!)
        assertEquals(expected, request.header(CollectorSigner.SIGNATURE_HEADER))
        assertEquals("https://example.invalid/api/collector/android/jobs/claim", request.url.toString())
        request.headers.forEach { (_, value) -> assertFalse(value.contains(token)) }
        assertNull(request.header("Authorization"))
    }

    @Test
    fun closedGateBlocksEveryLiveCallBeforeAnyNetworkUse() {
        val client = SignedCollectorClient(
            CollectorCredentials("https://example.invalid", "dev-1", token),
            LiveCollectionGate(buildAllowsLive = false, facebookSessionConsent = true),
        )
        try {
            client.claim()
            fail("claim must be refused while the gate is closed")
        } catch (expected: LiveCollectionDisabledException) {
            // refused before DNS: example.invalid never resolves
        }
        assertFalse(LiveCollectionGate(buildAllowsLive = true, facebookSessionConsent = false).open)
        assertTrue(LiveCollectionGate(buildAllowsLive = true, facebookSessionConsent = true).open)
    }

    @Test
    fun credentialsNeverPrintTheToken() {
        val text = CollectorCredentials("https://example.invalid", "dev-1", token).toString()
        assertFalse(text.contains(token))
    }

    @Test(expected = IllegalArgumentException::class)
    fun credentialsRequireHttps() {
        CollectorCredentials("http://example.invalid", "dev-1", token)
    }
}
