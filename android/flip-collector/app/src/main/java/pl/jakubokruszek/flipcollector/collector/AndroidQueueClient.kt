package pl.jakubokruszek.flipcollector.collector

import org.json.JSONObject
import pl.jakubokruszek.flipcollector.integration.RemoteGroup

/** Transport boundary; fixtures and signed HTTPS exercise the same lifecycle. */
interface AndroidQueueClient {
    fun claim(sourceIds: List<String>? = null): ClaimedJob?
    fun renewLease(job: ClaimedJob): String?
    fun deviceStatus(): JSONObject
    fun sources(): List<RemoteGroup>
    fun status(job: ClaimedJob): JSONObject
    fun diagnostics(job: ClaimedJob): JSONObject
    fun prepareCompletion(job: ClaimedJob, batch: JSONObject? = null, failure: String? = null, cancelled: Boolean = false): PendingCompletion
    fun sendCompletion(pending: PendingCompletion): JSONObject
}
