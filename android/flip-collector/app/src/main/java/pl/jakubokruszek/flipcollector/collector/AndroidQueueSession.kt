package pl.jakubokruszek.flipcollector.collector

import kotlinx.coroutines.*
import org.json.JSONObject

/** One claimed source at a time. Caller must run in LIVE mode; DEMO never calls this. */
class AndroidQueueSession(
    private val client: SignedCollectorClient,
    private val outbox: CompletionOutbox,
    private val enabled: Boolean = false,
) {
    suspend fun runOne(collect: suspend (ClaimedJob) -> JSONObject): JSONObject? = coroutineScope {
        check(enabled) { "Android queue session is disabled" }
        // Drain durable bytes before any new claim, including after process death.
        withContext(Dispatchers.IO) { outbox.flush(client) }
        val job = withContext(Dispatchers.IO) { client.claim() } ?: return@coroutineScope null
        val renewal = launch {
            while (isActive) {
                delay(45_000)
                withContext(Dispatchers.IO) { client.renewLease(job) }
            }
        }
        var settled = false
        var settledReceipt: JSONObject? = null
        try {
            val batch = collect(job)
            // Persist before the first send; a crash or cancellation cannot
            // replace these bytes with a new completionId or a cancel request.
            withContext(NonCancellable + Dispatchers.IO) {
                val pending = client.prepareCompletion(job, batch = batch)
                outbox.enqueue(pending)
                settledReceipt = outbox.flush(client)
                settled = true
            }
            requireNotNull(settledReceipt)
        } catch (cancelled: CancellationException) {
            withContext(NonCancellable + Dispatchers.IO) {
                if (!settled && outbox.pending() == null) {
                    outbox.enqueue(client.prepareCompletion(job, cancelled = true))
                    runCatching { outbox.flush(client) }
                }
            }
            throw cancelled
        } catch (error: Exception) {
            withContext(NonCancellable + Dispatchers.IO) {
                if (!settled && outbox.pending() == null) {
                    outbox.enqueue(client.prepareCompletion(job, failure = "ANDROID_COLLECTION_FAILED"))
                    runCatching { outbox.flush(client) }
                }
            }
            throw error
        } finally { renewal.cancelAndJoin() }
    }
}
