package pl.jakubokruszek.flipcollector.integration

import org.json.JSONArray
import org.json.JSONObject
import pl.jakubokruszek.flipcollector.collector.*
import pl.jakubokruszek.flipcollector.watcher.WatcherCodec

interface AtomicAutomationStorage {
    fun read(): String?
    /** One encrypted, synchronous replacement; never partial writes. */
    fun write(value: String)
}

/** Separate OFFLINE_TEST journal; never consumes DEMO/LIVE cursors or outboxes. */
class AutomationState(private val disk: AtomicAutomationStorage) : CompletionStorage, WindowCursorStorage {
    private fun read(): JSONObject = disk.read()?.let(::JSONObject) ?: JSONObject().put("mode", "OFFLINE_TEST")
    private fun <T> change(block: (JSONObject) -> T): T = synchronized(lock) {
        val row = read(); check(row.getString("mode") == "OFFLINE_TEST")
        val result = block(row); disk.write(row.toString()); result
    }
    override fun load(): PendingCompletion? = synchronized(lock) {
        read().optJSONObject("pending")?.let { PendingCompletion(it.getString("deviceId"), it.getString("jobId"), it.getString("leaseToken"), it.getString("completionId"), it.getString("rawBody")) }
    }
    override fun save(value: PendingCompletion?) { change { row ->
        if (value == null) row.remove("pending") else row.put("pending", JSONObject().put("deviceId",value.deviceId).put("jobId",value.jobId).put("leaseToken",value.leaseToken).put("completionId",value.completionId).put("rawBody",value.rawBody))
    } }
    override fun load(windowKey: String, mode: String): WindowCursor? = synchronized(lock) {
        require(mode == "OFFLINE_TEST")
        read().optJSONObject("cursor")?.takeIf { it.getString("windowKey") == windowKey }?.let {
            WindowCursor(windowKey, mode, strings(it.getJSONArray("pending")), strings(it.getJSONArray("finished")).toSet())
        }
    }
    override fun save(cursor: WindowCursor) { change { row ->
        require(cursor.mode == "OFFLINE_TEST")
        val old = row.optJSONObject("cursor")?.takeIf { it.getString("windowKey") == cursor.windowKey }
        val finished = cursor.finished + old?.getJSONArray("finished")?.let(::strings).orEmpty()
        row.put("cursor", JSONObject().put("windowKey", cursor.windowKey).put("pending", JSONArray(cursor.pending)).put("finished", JSONArray(finished.toList())))
    } }
    fun groups(): List<SyncedGroup> = synchronized(lock) {
        val raw=read().optString("groups").ifBlank { "[]" }
        val array=JSONArray(raw)
        for(index in 0 until array.length()) {
            val group=array.getJSONObject(index)
            group.getBoolean("active");group.getBoolean("serverEnabled");group.getString("accessStatus");group.getString("sourceType")
        }
        val decoded=WatcherCodec.decodeSyncedGroups(raw)
        check(decoded.size==array.length()) { "GROUP_STATE_CORRUPT" };decoded
    }
    fun groups(value: List<SyncedGroup>, syncedAt: Long? = null) { change { row ->
        row.put("groups", WatcherCodec.encodeSyncedGroups(value)); if (syncedAt != null) row.put("lastSync", syncedAt)
    } }
    fun active(): JSONObject? = synchronized(lock) { read().optJSONObject("active") }
    fun claimed(window: String, source: String, job: ClaimedJob) { change { row ->
        check(row.optJSONObject("active")?.getString("jobId")?.let { it == job.id } != false)
        row.put("active",JSONObject().put("window",window).put("source",source).put("jobId",job.id).put("leaseToken",job.leaseToken).put("runId",job.runId).put("group",job.group))
    } }
    fun clearExpiredClaim() { change { row -> check(row.optJSONObject("pending") == null); row.remove("active") } }
    fun activeJob(): ClaimedJob? = active()?.let { ClaimedJob(it.getString("jobId"),it.getString("leaseToken"),it.getString("runId"),"SOURCE_SCAN",it.getJSONObject("group")) }

    /** Idempotent receipt + cursor + active journal commit before outbox clear. */
    fun acknowledge(pending: PendingCompletion, receipt: JSONObject) { change { row ->
        require(receipt.getString("completionId") == pending.completionId && receipt.getBoolean("ok"))
        val results = row.optJSONObject("results") ?: JSONObject()
        if (!results.has(pending.completionId)) {
            val active = requireNotNull(row.optJSONObject("active")) { "MISSING_ACTIVE_JOURNAL" }
            check(active.getString("jobId") == pending.jobId)
            val result = receipt.optJSONObject("result")
            val counts = result?.optJSONObject("writeAccounting")?.takeIf { it.optInt("version") == 1 && it.optString("basis") == "TRANSACTIONAL" }
            if(counts!=null) for(key in listOf("created","updated","duplicates")) require(counts.getInt(key)>=0)
            val summary = JSONObject().put("window",active.getString("window")).put("source",active.getString("source"))
                .put("name",active.getJSONObject("group").getString("name")).put("status",receipt.getString("status"))
                .put("created",counts?.getInt("created") ?: JSONObject.NULL).put("updated",counts?.getInt("updated") ?: JSONObject.NULL)
                .put("duplicates",counts?.getInt("duplicates") ?: JSONObject.NULL).put("skipped",if(result?.has("skipped")==true) result.getInt("skipped") else JSONObject.NULL)
            if(receipt.getString("status")=="failed") {
                val body=JSONObject(pending.rawBody)
                val code=if(body.optString("status")=="cancelled") "ANDROID_CANCELLED" else body.optString("errorCode","ANDROID_COLLECTION_FAILED")
                require(Regex("^[A-Z0-9_]{1,100}$").matches(code));summary.put("error",code)
            }
            results.put(pending.completionId, summary)
            check(results.length() <= 500) { "OFFLINE_HISTORY_FULL" }
            val cursor = row.optJSONObject("cursor")
            if (cursor != null && cursor.getString("windowKey") == active.getString("window")) {
                cursor.put("finished", JSONArray((strings(cursor.getJSONArray("finished")) + active.getString("source")).distinct()))
            }
            row.put("results",results)
        }
        row.remove("active"); row.put("queueStatus","SETTLED"); row.remove("lastError")
    } }
    fun device(paired: Boolean) { change { it.put("paired",paired) } }
    fun event(status: String, error: String? = null) { change { row ->
        require(Regex("^[A-Z0-9_]{1,100}$").matches(status))
        row.put("queueStatus",status)
        if (error != null) { require(Regex("^[A-Z0-9_]{1,100}$").matches(error)); row.put("lastError",error) }
    } }
    /** Whitelisted fields: no lease, body, token, URL, signature or post text. */
    fun diagnostics(): JSONObject = synchronized(lock) {
        val row=read(); val results=row.optJSONObject("results") ?: JSONObject(); val list=JSONArray()
        results.keys().forEach { list.put(results.getJSONObject(it)) }
        JSONObject().put("mode","OFFLINE_TEST").put("lastSync",row.optLong("lastSync",0)).put("paired",row.optBoolean("paired"))
            .put("queue",row.optString("queueStatus","IDLE")).put("pending",row.has("pending")).put("error",row.optString("lastError"))
            .put("sources",groups().size).put("results",list)
    }
    companion object {
        private val lock=Any()
        private fun strings(array: JSONArray) = (0 until array.length()).map { array.getString(it) }
    }
}
