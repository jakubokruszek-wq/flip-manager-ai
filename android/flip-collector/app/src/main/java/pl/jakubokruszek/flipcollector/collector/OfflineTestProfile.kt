package pl.jakubokruszek.flipcollector.collector

import java.net.URI
import java.util.UUID
import org.json.JSONObject

/** Public origin is compiled into an approved test APK; secrets are provisioned separately. */
class OfflineTestProfile private constructor(val credentials: CollectorCredentials, val expiresAt: Long) {
    override fun toString() = "OfflineTestProfile(redacted)"
    companion object {
        fun parse(raw: String, approvedOrigin: String, now: Long = System.currentTimeMillis()): OfflineTestProfile {
            require(raw.length <= 8192 && approvedOrigin.isNotBlank()) { "REMOTE_TEST_NOT_CONFIGURED" }
            val uri = URI(approvedOrigin)
            require(uri.scheme == "https" && uri.host != null && uri.userInfo == null && uri.rawQuery == null && uri.fragment == null && uri.path.orEmpty() in setOf("", "/"))
            val host=uri.host.lowercase()
            require(host != "flip-manager-ai.vercel.app" && !host.endsWith(".supabase.co"))
            require(host !in setOf("localhost", "127.0.0.1", "10.0.2.2"))
            val value = JSONObject(raw)
            require(value.getInt("version") == 1 && value.getString("dataMode") == "OFFLINE_TEST")
            val origin = value.getString("origin")
            require(origin == approvedOrigin.trimEnd('/')) { "REMOTE_TEST_ORIGIN_MISMATCH" }
            val deviceId = value.getString("deviceId")
            require(UUID.fromString(deviceId).toString() == deviceId)
            val token = value.getString("deviceToken")
            require(Regex("^[A-Za-z0-9_-]{43}$").matches(token)) { "REMOTE_TEST_KEY_INVALID" }
            val expiresAt = value.getLong("expiresAt")
            require(expiresAt > now && expiresAt <= now + 7 * 86400_000L) { "REMOTE_TEST_EXPIRED" }
            return OfflineTestProfile(CollectorCredentials(origin, deviceId, token), expiresAt)
        }
    }
}
