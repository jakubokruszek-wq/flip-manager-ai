package pl.jakubokruszek.flipcollector.collector

import org.json.JSONObject

/** Contains lease/data, never print contents or include in diagnostic exports. */
data class PendingCompletion(val deviceId: String, val jobId: String, val leaseToken: String, val completionId: String, val rawBody: String) {
    override fun toString() = "PendingCompletion(redacted)"
}

interface CompletionStorage {
    fun load(): PendingCompletion?
    /** Must commit synchronously, or throw. */
    fun save(value: PendingCompletion?)
}

/** One slot per installation: do not claim while an ambiguous completion exists. */
class CompletionOutbox(private val storage: CompletionStorage) {
    @Synchronized fun pending(): PendingCompletion? = storage.load()
    @Synchronized fun enqueue(value: PendingCompletion) {
        val old = storage.load()
        check(old == null || old == value) { "Unsettled completion already exists" }
        storage.save(value)
    }
    @Synchronized fun flush(client: SignedCollectorClient): JSONObject? {
        val item = storage.load() ?: return null
        val receipt = client.sendCompletion(item) // Exceptions leave identical bytes durable.
        storage.save(null) // A clear failure is safe: replay returns the same receipt.
        return receipt
    }
}
