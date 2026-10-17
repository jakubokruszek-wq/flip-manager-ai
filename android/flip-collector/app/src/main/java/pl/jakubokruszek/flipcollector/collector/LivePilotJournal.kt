package pl.jakubokruszek.flipcollector.collector

import org.json.JSONObject
import pl.jakubokruszek.flipcollector.integration.AtomicAutomationStorage
import java.util.UUID

/** Provisioned only after separate approval of the dedicated backend and group. */
class LivePilotProfile private constructor(val credentials: CollectorCredentials, val source: LivePilotSource, val expiresAt: Long) {
    override fun toString() = "LivePilotProfile(redacted)"
    companion object {
        fun parse(raw: String, approvedOrigin: String, now: Long = System.currentTimeMillis()): LivePilotProfile {
            require(raw.length <= 8192 && approvedOrigin.isNotBlank()) { "PILOT_NOT_CONFIGURED" }
            val value = JSONObject(raw)
            require(value.getInt("version") == 1 && value.getString("purpose") == "LIVE_PILOT" && value.getString("dataMode") == "LIVE")
            require(value.getInt("maxPosts") == LivePilotPolicy.MAX_POSTS)
            val origin = value.getString("origin")
            require(origin == approvedOrigin && origin != "https://flip-manager-ai.vercel.app" && !origin.endsWith(".supabase.co"))
            val id = value.getString("deviceId")
            require(UUID.fromString(id).toString() == id)
            val token = value.getString("deviceToken")
            require(Regex("^[A-Za-z0-9_-]{43}$").matches(token))
            val expires = value.getLong("expiresAt")
            require(expires > now && expires <= now + 3600_000) { "PILOT_PROFILE_EXPIRED" }
            val source = value.getJSONObject("source")
            return LivePilotProfile(CollectorCredentials(origin, id, token),
                LivePilotSource(source.getString("id"), source.getString("sourceId"), source.getString("url")), expires)
        }
    }
}

/** Separate encrypted journal; never opens OFFLINE_TEST's storage or history. */
class LivePilotJournal(private val disk: AtomicAutomationStorage) : CompletionStorage {
    private fun read() = (disk.read()?.let(::JSONObject) ?: JSONObject().put("mode", "LIVE_PILOT")).also {
        check(it.getString("mode") == "LIVE_PILOT")
    }
    private fun change(action: (JSONObject) -> Unit) = synchronized(lock) {
        val row = read(); action(row); disk.write(row.toString())
    }
    fun configure(raw: String) = change { row ->
        if (row.has("pending") || row.has("active")) {
            // An expired one-hour approval may be renewed for recovery, but
            // credentials/source/origin cannot be replaced under an old body.
            val old = JSONObject(row.getString("profile"))
            val next = JSONObject(raw)
            check(listOf("origin", "deviceId", "deviceToken", "purpose", "dataMode").all { old.getString(it) == next.getString(it) } &&
                listOf("id", "sourceId", "url").all { old.getJSONObject("source").getString(it) == next.getJSONObject("source").getString(it) }) { "PILOT_UNSETTLED" }
        }
        row.put("profile", raw)
    }
    fun profile(): String? = synchronized(lock) { read().optString("profile").ifBlank { null } }
    fun claimed(job: ClaimedJob) = change { row ->
        check(!row.has("active")) { "PILOT_RECOVERY_REQUIRED" }
        row.put("active", JSONObject().put("id",job.id).put("leaseToken",job.leaseToken).put("runId",job.runId).put("group",job.group))
        row.remove("finishedAt")
        row.put("startedAt", System.currentTimeMillis()).put("heartbeat", System.currentTimeMillis()).put("visible", 0).put("verified", 0).put("stop", "")
    }
    fun active(): ClaimedJob? = synchronized(lock) { read().optJSONObject("active")?.let {
        ClaimedJob(it.getString("id"), it.getString("leaseToken"), it.getString("runId"), "SOURCE_SCAN", it.getJSONObject("group"))
    } }
    override fun load(): PendingCompletion? = synchronized(lock) { read().optJSONObject("pending")?.let {
        PendingCompletion(it.getString("deviceId"),it.getString("jobId"),it.getString("leaseToken"),it.getString("completionId"),it.getString("rawBody"))
    } }
    override fun save(value: PendingCompletion?) = change { row ->
        if (value == null) row.remove("pending") else {
            check(row.optJSONObject("pending")?.getString("completionId")?.let { it == value.completionId } != false)
            row.put("pending",JSONObject().put("deviceId",value.deviceId).put("jobId",value.jobId).put("leaseToken",value.leaseToken).put("completionId",value.completionId).put("rawBody",value.rawBody))
        }
    }
    fun heartbeat() = change { it.put("heartbeat", System.currentTimeMillis()) }
    fun captured(batch: JSONObject) = change {
        val posts = batch.getJSONArray("posts")
        it.put("visible", batch.getJSONObject("health").getInt("visibleCardCount"))
            .put("verified", (0 until posts.length()).count { i -> posts.getJSONObject(i).getString("identityConfidence") == "EXACT" })
    }
    fun stop(code: String) = change {
        require(Regex("^[A-Z0-9_]{1,100}$").matches(code))
        it.put("stop", code).put("finishedAt", System.currentTimeMillis())
    }
    fun acknowledge(pending: PendingCompletion, receipt: JSONObject) = change { row ->
        require(receipt.getBoolean("ok") && receipt.getString("completionId") == pending.completionId && receipt.getString("status") in setOf("completed", "failed"))
        val receipts = row.optJSONObject("receipts") ?: JSONObject()
        if (!receipts.has(pending.completionId)) {
            check(row.getJSONObject("active").getString("id") == pending.jobId)
            check(receipts.length() < 100) { "PILOT_HISTORY_FULL" }
            // Keep acknowledgment without post text, IDs, names, token or lease.
            receipts.put(pending.completionId, JSONObject().put("status",receipt.getString("status")).put("receivedAt",System.currentTimeMillis()))
        }
        row.put("receipts", receipts).remove("active")
        row.put("finishedAt", System.currentTimeMillis())
    }
    /** Allowlist only. Never export profile, Facebook identifiers, text or raw exceptions. */
    fun diagnostics(): JSONObject = synchronized(lock) {
        val row = read()
        JSONObject().put("mode", "LIVE_PILOT").put("configured", row.has("profile")).put("pending",row.has("pending")).put("active",row.has("active"))
            .put("receipts",row.optJSONObject("receipts")?.length() ?: 0).put("visible",row.optInt("visible")).put("verified",row.optInt("verified"))
            .put("startedAt",row.optLong("startedAt")).put("finishedAt",row.optLong("finishedAt")).put("heartbeat",row.optLong("heartbeat"))
            .put("stop",row.optString("stop"))
    }
    companion object { private val lock = Any() }
}
