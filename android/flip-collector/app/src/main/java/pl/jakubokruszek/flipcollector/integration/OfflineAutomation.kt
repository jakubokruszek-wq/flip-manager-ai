package pl.jakubokruszek.flipcollector.integration

import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import pl.jakubokruszek.flipcollector.collector.*

/** The production gates stay closed: this engine is only wired to loopback fixtures. */
class OfflineAutomation(
    private val api: AndroidQueueClient,
    private val state: AutomationState,
    private val clock: () -> Long = System::currentTimeMillis,
    private val heartbeatMs: Long = 45_000,
) {
    suspend fun run(windowKey: String, windowEndsAt: Long, conditions: () -> CycleConditions,
        collect: suspend (ClaimedJob) -> JSONObject): String = lock.withLock {
        val outbox=CompletionOutbox(state)
        try {
            val deviceConditions=conditions()
            if(!deviceConditions.wifi || !deviceConditions.charging || deviceConditions.thermalSevere || deviceConditions.batteryPercent==null || deviceConditions.batteryPercent<20 || clock()>=windowEndsAt) {
                state.event("DEVICE_CONSTRAINT"); return@withLock "DEVICE_CONSTRAINT"
            }
            // Reconcile durable bytes before syncing, claiming or replacing a cursor.
            withContext(Dispatchers.IO) { outbox.flush(api, state::acknowledge) }
            val device=withContext(Dispatchers.IO) { api.deviceStatus() }
            check(device.getBoolean("paired") && device.getString("consumerType") == "ANDROID_WEBVIEW")
            state.device(true)
            val remote=withContext(Dispatchers.IO) { api.sources() }
            val merged=GroupSync.merge(state.groups(),remote) { it.remoteId }.first
            state.groups(merged,clock())
            val eligible=merged.filter { it.scannable && it.remoteId != null }.sortedWith(
                compareBy<SyncedGroup> { when(it.priority) { "high" -> 0; "normal" -> 1; else -> 2 } }.thenBy { it.remoteId })
            // A killed process may leave a claimed lease but no completion body.
            val active=state.activeJob()
            if(active != null) {
                try { withContext(Dispatchers.IO) { api.renewLease(active) } }
                catch(error: CollectorHttpException) {
                    if(error.code != "ANDROID_JOB_LEASE_LOST") throw error
                    state.clearExpiredClaim(); state.event("LEASE_RECOVERING",error.code)
                }
            }
            val ids=eligible.map { requireNotNull(it.remoteId) }
            // A locally disabled/deleted source may own an old lease; cancel it,
            // never collect its HTML or claim another job while it is owned.
            state.active()?.let { old ->
                if(old.getString("window") != windowKey || old.getString("source") !in ids) {
                    val job=requireNotNull(state.activeJob())
                    withContext(Dispatchers.IO) {
                        outbox.enqueue(api.prepareCompletion(job,cancelled=true))
                        outbox.flush(api,state::acknowledge)
                    }
                }
            }
            val result=WindowCycleController(state,clock).runCycle(windowKey,"OFFLINE_TEST",ids,windowEndsAt,conditions) { source ->
                if(state.groups().none { it.remoteId==source && it.scannable }) return@runCycle SourceSettlement.DEFERRED
                state.event("RUNNING")
                try {
                    val receipt=AndroidQueueSession(api,outbox,true,heartbeatMs).runOne(
                        sourceIds=listOf(source), resumeJob=state.activeJob(),
                        onClaim={ job ->
                            check(job.group?.getString("id") == source) { "SOURCE_JOB_MISMATCH" }
                            state.claimed(windowKey,source,job)
                        },onReceipt=state::acknowledge,collect=collect)
                    when(receipt?.getString("status")) {
                        "completed" -> SourceSettlement.SETTLED
                        "failed" -> SourceSettlement.SETTLED_FAILURE
                        else -> SourceSettlement.DEFERRED
                    }
                } catch(cancelled: CancellationException) { throw cancelled }
                catch(error: Exception) {
                    val finished=state.load(windowKey,"OFFLINE_TEST")?.finished.orEmpty()
                    if(source in finished) SourceSettlement.SETTLED_FAILURE
                    else {
                        if(error is CollectorHttpException && error.code == "ANDROID_JOB_LEASE_LOST" && state.load() == null) state.clearExpiredClaim()
                        state.event("RETRY_REQUIRED",safeCode(error))
                        if(state.load() != null) SourceSettlement.RECONCILIATION_REQUIRED else SourceSettlement.DEFERRED
                    }
                }
            }
            state.event(result); result
        } catch(cancelled: CancellationException) {
            state.event("INTERRUPTED"); throw cancelled
        } catch(error: Exception) {
            state.event(if(state.load() != null) "RECONCILIATION_REQUIRED" else "RETRY_REQUIRED",safeCode(error))
            if(state.load() != null) "RECONCILIATION_REQUIRED" else "RETRY_REQUIRED"
        }
    }
    companion object {
        private val lock=Mutex()
        fun safeCode(error: Exception): String = if(error is CollectorHttpException) error.code else if(error is java.io.IOException) "API_UNAVAILABLE" else "OFFLINE_CYCLE_FAILED"
    }
}
