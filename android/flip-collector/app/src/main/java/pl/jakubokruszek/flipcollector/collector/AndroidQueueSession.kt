package pl.jakubokruszek.flipcollector.collector

import kotlinx.coroutines.*
import org.json.JSONObject

/** One claimed source at a time. Caller must run in LIVE mode; DEMO never calls this. */
class AndroidQueueSession(
    private val client: AndroidQueueClient,
    private val outbox: CompletionOutbox,
    private val enabled: Boolean = false,
    private val heartbeatMs: Long = 45_000,
) {
    suspend fun runOne(sourceIds: List<String>? = null, resumeJob: ClaimedJob? = null,
        onClaim: (ClaimedJob) -> Unit = {}, onReceipt: (PendingCompletion, JSONObject) -> Unit = { _, _ -> },
        onHeartbeat: () -> Unit = {},
        collect: suspend (ClaimedJob) -> JSONObject): JSONObject? = supervisorScope {
        check(enabled) { "Android queue session is disabled" }
        // Drain durable bytes before any new claim, including after process death.
        val recovered = withContext(Dispatchers.IO) { outbox.flush(client, onReceipt) }
        if (recovered != null) return@supervisorScope recovered
        val job = resumeJob ?: withContext(Dispatchers.IO) { client.claim(sourceIds) } ?: return@supervisorScope null
        onClaim(job)
        val renewalFailure=java.util.concurrent.atomic.AtomicReference<Exception?>()
        val collection=async(start=CoroutineStart.LAZY) { collect(job) }
        val renewal = launch {
            while (isActive) {
                delay(heartbeatMs)
                try { withContext(Dispatchers.IO) { client.renewLease(job); onHeartbeat() } }
                catch(cancelled: CancellationException) { throw cancelled }
                catch(error: Exception) {
                    renewalFailure.set(error)
                    collection.cancel(CancellationException("LEASE_HEARTBEAT_FAILED",error))
                    break
                }
            }
        }
        var settled = false
        var settledReceipt: JSONObject? = null
        try {
            val batch = collection.await()
            // Persist before the first send; a crash or cancellation cannot
            // replace these bytes with a new completionId or a cancel request.
            withContext(NonCancellable + Dispatchers.IO) {
                val pending = client.prepareCompletion(job, batch = batch)
                outbox.enqueue(pending)
                settledReceipt = outbox.flush(client, onReceipt)
                settled = true
            }
            requireNotNull(settledReceipt)
        } catch (cancelled: CancellationException) {
            // No import has started. A lost/unknown lease must be reconciled,
            // not replaced with a cancellation completion using stale fencing.
            renewalFailure.get()?.let { throw it }
            withContext(NonCancellable + Dispatchers.IO) {
                if (!settled && outbox.pending() == null) {
                    outbox.enqueue(client.prepareCompletion(job, cancelled = true))
                    runCatching { outbox.flush(client, onReceipt) }
                }
            }
            throw cancelled
        } catch (error: Exception) {
            withContext(NonCancellable + Dispatchers.IO) {
                if (!settled && outbox.pending() == null && !(error is CollectorHttpException && error.code == "ANDROID_JOB_LEASE_LOST")) {
                    outbox.enqueue(client.prepareCompletion(job, failure = "ANDROID_COLLECTION_FAILED"))
                    runCatching { outbox.flush(client, onReceipt) }
                }
            }
            throw error
        } finally { collection.cancelAndJoin(); renewal.cancelAndJoin() }
    }
}

