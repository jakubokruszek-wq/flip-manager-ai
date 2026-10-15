package pl.jakubokruszek.flipcollector.collector

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.net.URI
import java.util.UUID
import pl.jakubokruszek.flipcollector.integration.RemoteGroup

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
        val uri = URI(baseUrl)
        require(uri.scheme == "https" && uri.host != null && uri.userInfo == null && uri.rawQuery == null && uri.fragment == null && uri.path.orEmpty() in listOf("", "/")) { "Flip Manager URL must be an HTTPS origin" }
    }

    /** Never prints the token. */
    override fun toString(): String = "CollectorCredentials(baseUrl=$baseUrl, deviceId=$deviceId, deviceToken=***)"
}

data class ClaimedJob(val id: String, val leaseToken: String, val runId: String, val jobType: String?, val group: JSONObject?) {
    override fun toString() = "ClaimedJob(redacted)"
}

class CollectorHttpException(val status: Int, val code: String) : RuntimeException("HTTP $status: $code")

/**
 * Signed client for /api/collector/android/jobs/{claim,heartbeat,complete}. Every
 * signed call refreshes the device heartbeat on the server, which can make the
 * scheduler treat the phone as a ready collector, so each call first checks
 * [gate]. With the gate closed nothing leaves the phone.
 */
class SignedCollectorClient(
    private val credentials: CollectorCredentials,
    private val gate: LiveCollectionGate,
    private val client: OkHttpClient = OkHttpClient.Builder().callTimeout(30, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build(),
    private val nowMillis: () -> Long = System::currentTimeMillis,
    private val metadataEnabled: Boolean = false,
    private val dataMode: String = "LIVE",
) : AndroidQueueClient {
    init {
        require(dataMode in setOf("LIVE", "OFFLINE_TEST"))
        require(dataMode != "OFFLINE_TEST" || URI(credentials.baseUrl).host in setOf("localhost", "127.0.0.1", "10.0.2.2")) { "Offline imports require loopback fixture API" }
    }

    private val transport = client.newBuilder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build()

    override fun claim(sourceIds: List<String>?): ClaimedJob? {
        require(sourceIds == null || (sourceIds.size <= 50 && sourceIds.all { runCatching { UUID.fromString(it).toString() == it }.getOrDefault(false) }))
        val response = post(CLAIM_PATH, if (sourceIds == null) "{}" else JSONObject().put("sourceIds", org.json.JSONArray(sourceIds)).toString())
        val job = response.optJSONObject("job") ?: return null
        require(job.getString("consumerType") == "ANDROID_WEBVIEW" && job.getString("jobType") == "SOURCE_SCAN" && job.getString("imageMode") == "SOURCE_SCAN_DATA_ONLY") { "Unexpected job contract" }
        return ClaimedJob(
            id = job.getString("id"),
            leaseToken = job.getString("leaseToken"),
            runId = job.getString("runId"),
            jobType = job.optString("jobType").ifBlank { null },
            group = job.optJSONObject("group"),
        )
    }

    override fun renewLease(job: ClaimedJob): String? =
        post(HEARTBEAT_PATH, JSONObject().put("jobId", job.id).put("leaseToken", job.leaseToken).toString()).optString("leasedUntil").ifBlank { null }

    override fun deviceStatus(): JSONObject = post(DEVICE_STATUS_PATH, "{}")

    override fun sources(): List<RemoteGroup> {
        val snapshot = post(SOURCES_PATH, "{}")
        require(snapshot.optBoolean("completeSnapshot")) { "Incomplete source snapshot" }
        val rows = snapshot.getJSONArray("sources")
        require(rows.length() <= 50) { "Too many sources" }
        val sources = (0 until rows.length()).map { index ->
            val row = rows.getJSONObject(index)
            RemoteGroup(row.getString("id"), row.getString("name"),
                if (row.isNull("url")) "" else row.getString("url"), row.getBoolean("enabled"),
                sourceType = row.optString("type", "UNKNOWN"), priority = row.getString("priority"),
                accessStatus = row.getString("accessStatus"))
        }
        require(sources.map { it.remoteId }.distinct().size == sources.size) { "Duplicate source IDs" }
        return sources
    }

    override fun status(job: ClaimedJob): JSONObject = post(STATUS_PATH, leaseBody(job).toString())
    override fun diagnostics(job: ClaimedJob): JSONObject = post(DIAGNOSTICS_PATH, leaseBody(job).toString())

    override fun prepareCompletion(job: ClaimedJob, batch: JSONObject?, failure: String?, cancelled: Boolean): PendingCompletion {
        require(!(cancelled && batch != null) && !(failure != null && batch != null))
        val id = UUID.randomUUID().toString()
        val body = leaseBody(job).put("completionId", id).put("dataMode", dataMode)
        when {
            cancelled -> body.put("status", "cancelled")
            failure != null -> { require(Regex("^[A-Z0-9_]{1,100}$").matches(failure)); body.put("status", "failed").put("errorCode", failure) }
            else -> {
                require(batch != null) { "A successful completion needs a batch" }
                // Snapshot before signing; the caller must not mutate an outbox body.
                val copy = JSONObject(batch.toString()).put("batchId", id).put("scanId", job.runId).put("imageMode", "SOURCE_SCAN_DATA_ONLY")
                body.put("status", "completed").put("batch", copy)
            }
        }
        return PendingCompletion(credentials.deviceId, job.id, job.leaseToken, id, body.toString())
    }

    /** Exact persisted bytes; retry creates new auth headers, never a new body. */
    override fun sendCompletion(pending: PendingCompletion): JSONObject {
        require(pending.deviceId == credentials.deviceId) { "Outbox belongs to another device" }
        val receipt = post(COMPLETE_PATH, pending.rawBody)
        require(receipt.optBoolean("ok") && receipt.getString("completionId") == pending.completionId && receipt.getString("status") in listOf("completed", "failed")) { "Invalid receipt" }
        return receipt
    }

    private fun leaseBody(job: ClaimedJob) = JSONObject().put("jobId", job.id).put("leaseToken", job.leaseToken)

    /** Builds the signed request without sending it; used by tests and by [post]. */
    fun buildSignedPost(pathname: String, body: String): Request {
        require(pathname in PATHS) { "Unknown collector path" }
        val bytes = body.toByteArray(Charsets.UTF_8)
        require(bytes.size <= 2 * 1024 * 1024) { "Body too large" }
        val headers = CollectorSigner.headers(credentials.deviceId, credentials.deviceToken, "POST", pathname, bytes, nowMillis())
        return Request.Builder()
            .url(credentials.baseUrl.trimEnd('/') + pathname)
            .apply { headers.forEach { (name, value) -> header(name, value) } }
            .post(bytes.toRequestBody(JSON))
            .build()
    }

    private fun post(pathname: String, body: String): JSONObject {
        if (pathname.startsWith("/api/collector/android/jobs/") && dataMode != "OFFLINE_TEST") gate.check()
        else if (pathname.startsWith("/api/collector/android/jobs/")) check(metadataEnabled) { "Offline fixture integration disabled" }
        else check(metadataEnabled) { "Android backend integration is disabled" }
        transport.newCall(buildSignedPost(pathname, body)).execute().use { response ->
            val source = response.body?.source()
            if (source != null && source.request(2L * 1024 * 1024 + 1)) throw CollectorHttpException(502, "RESPONSE_TOO_LARGE")
            val text = source?.readUtf8().orEmpty()
            val json = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
            if (!response.isSuccessful) throw CollectorHttpException(response.code, json.optString("code").takeIf { Regex("^[A-Z0-9_]{1,100}$").matches(it) } ?: "HTTP_${response.code}")
            if (json.optBoolean("ok") != true) throw CollectorHttpException(response.code, "INVALID_RESPONSE")
            return json
        }
    }

    companion object {
        const val CLAIM_PATH = "/api/collector/android/jobs/claim"
        const val HEARTBEAT_PATH = "/api/collector/android/jobs/heartbeat"
        const val COMPLETE_PATH = "/api/collector/android/jobs/complete"
        const val STATUS_PATH = "/api/collector/android/jobs/status"
        const val SOURCES_PATH = "/api/collector/android/sources/sync"
        const val DEVICE_STATUS_PATH = "/api/collector/android/device/status"
        const val DIAGNOSTICS_PATH = "/api/collector/android/diagnostics"
        private val PATHS = setOf(CLAIM_PATH, HEARTBEAT_PATH, COMPLETE_PATH, STATUS_PATH, SOURCES_PATH, DEVICE_STATUS_PATH, DIAGNOSTICS_PATH)
        private val JSON = "application/json".toMediaType()
    }
}
