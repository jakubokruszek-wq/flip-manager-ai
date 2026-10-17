package pl.jakubokruszek.flipcollector.collector

import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Kotlin port of features/collector/protocol.ts. The server keeps only
 * sha256(token) and uses that lowercase hex string itself as the HMAC key, so
 * the phone signs with the same derived key and never sends the token.
 *
 * Canonical string: timestamp \n nonce \n METHOD \n pathname \n sha256hex(body)
 */
object CollectorSigner {
    const val DEVICE_HEADER = "x-flip-collector-device-id"
    const val TIMESTAMP_HEADER = "x-flip-collector-timestamp"
    const val NONCE_HEADER = "x-flip-collector-nonce"
    const val SIGNATURE_HEADER = "x-flip-collector-signature"

    /** The server accepts nonces matching ^[A-Za-z0-9_-]{16,128}$ (protocol.ts). */
    private val NONCE_PATTERN = Regex("^[A-Za-z0-9_-]{16,128}$")

    fun signingKey(deviceToken: String): String = sha256Hex(deviceToken.toByteArray(Charsets.UTF_8))

    fun canonical(method: String, pathname: String, body: ByteArray, timestamp: String, nonce: String): String =
        listOf(timestamp, nonce, method.uppercase(), pathname, sha256Hex(body)).joinToString("\n")

    fun sign(signingKey: String, method: String, pathname: String, body: ByteArray, timestamp: String, nonce: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(signingKey.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return hex(mac.doFinal(canonical(method, pathname, body, timestamp, nonce).toByteArray(Charsets.UTF_8)))
    }

    /**
     * Headers for one request. [body] must be the exact bytes sent: the server
     * hashes the raw request text, so any re-serialisation breaks the signature.
     */
    fun headers(
        deviceId: String,
        deviceToken: String,
        method: String,
        pathname: String,
        body: ByteArray,
        nowMillis: Long = System.currentTimeMillis(),
        nonce: String = UUID.randomUUID().toString(),
    ): Map<String, String> {
        require(deviceId.isNotBlank()) { "deviceId is required" }
        require(pathname.startsWith("/") && !pathname.contains('?')) { "pathname must be a bare path" }
        require(NONCE_PATTERN.matches(nonce)) { "nonce rejected by the server pattern" }
        val timestamp = nowMillis.toString()
        return linkedMapOf(
            DEVICE_HEADER to deviceId,
            TIMESTAMP_HEADER to timestamp,
            NONCE_HEADER to nonce,
            SIGNATURE_HEADER to sign(signingKey(deviceToken), method, pathname, body, timestamp, nonce),
        )
    }

    fun sha256Hex(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
}
