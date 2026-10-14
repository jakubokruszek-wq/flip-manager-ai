package pl.jakubokruszek.flipcollector.collector

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Whether this build may talk to the live job queue and open Facebook.
 * Both halves must hold: the build flag (false in this release) and the
 * user's separate consent to keep a Facebook session on the phone.
 */
data class LiveCollectionGate(val buildAllowsLive: Boolean, val facebookSessionConsent: Boolean) {
    val open: Boolean get() = buildAllowsLive && facebookSessionConsent

    fun check() {
        if (!open) throw LiveCollectionDisabledException()
    }
}

class LiveCollectionDisabledException : IllegalStateException(
    "Automatyczne zbieranie jest wyłączone w tej wersji aplikacji.",
)

data class CollectorCredentials(val baseUrl: String, val deviceId: String, val deviceToken: String) {
    init {
        require(baseUrl.startsWith("https://")) { "Flip Manager URL must use HTTPS" }
    }

    /** Never prints the token. */
    override fun toString(): String = "CollectorCredentials(baseUrl=$baseUrl, deviceId=$deviceId, deviceToken=***)"
}

data class ClaimedJob(val id: String, val leaseToken: String, val runId: String, val jobType: String?, val group: JSONObject?)

class CollectorHttpException(val status: Int, val code: String) : RuntimeException("HTTP $status: $code")

/**
 * Signed client for /api/collector/jobs/{claim,heartbeat,complete}. Every
 * signed call refreshes the device heartbeat on the server, which can make the
 * scheduler treat the phone as a ready collector, so each call first checks
 * [gate]. With the gate closed nothing leaves the phone.
 */
class SignedCollectorClient(
    private val credentials: CollectorCredentials,
    private val gate: LiveCollectionGate,
    private val client: OkHttpClient = OkHttpClient.Builder().callTimeout(30, TimeUnit.SECONDS).build(),
    private val nowMillis: () -> Long = System::currentTimeMillis,
) {
    fun claim(): ClaimedJob? {
        val response = post(CLAIM_PATH, "{}")
        val job = response.optJSONObject("job") ?: return null
        return ClaimedJob(
            id = job.getString("id"),
            leaseToken = job.getString("leaseToken"),
            runId = job.getString("runId"),
            jobType = job.optString("jobType").ifBlank { null },
            group = job.optJSONObject("group"),
        )
    }

    fun renewLease(job: ClaimedJob): String? =
        post(HEARTBEAT_PATH, JSONObject().put("jobId", job.id).put("leaseToken", job.leaseToken).toString()).optString("leasedUntil").ifBlank { null }

    fun complete(job: ClaimedJob, failed: Boolean, errorCode: String? = null) {
        val body = JSONObject()
            .put("jobId", job.id)
            .put("leaseToken", job.leaseToken)
            .put("status", if (failed) "failed" else "completed")
            .put("errorCode", if (failed) (errorCode ?: "COLLECTOR_FAILED").take(100) else JSONObject.NULL)
        post(COMPLETE_PATH, body.toString())
    }

    /** Builds the signed request without sending it; used by tests and by [post]. */
    fun buildSignedPost(pathname: String, body: String): Request {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val headers = CollectorSigner.headers(credentials.deviceId, credentials.deviceToken, "POST", pathname, bytes, nowMillis())
        return Request.Builder()
            .url(credentials.baseUrl.trimEnd('/') + pathname)
            .apply { headers.forEach { (name, value) -> header(name, value) } }
            .post(bytes.toRequestBody(JSON))
            .build()
    }

    private fun post(pathname: String, body: String): JSONObject {
        gate.check()
        client.newCall(buildSignedPost(pathname, body)).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val json = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
            if (!response.isSuccessful) throw CollectorHttpException(response.code, json.optString("code", "HTTP_${response.code}"))
            return json
        }
    }

    companion object {
        const val CLAIM_PATH = "/api/collector/jobs/claim"
        const val HEARTBEAT_PATH = "/api/collector/jobs/heartbeat"
        const val COMPLETE_PATH = "/api/collector/jobs/complete"
        private val JSON = "application/json".toMediaType()
    }
}
