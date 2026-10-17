package pl.jakubokruszek.flipcollector.integration

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.*

interface WindowCursorStorage {
    fun load(windowKey: String, mode: String): WindowCursor?
    fun save(cursor: WindowCursor)
}
enum class SourceSettlement { SETTLED, SETTLED_FAILURE, DEFERRED, RECONCILIATION_REQUIRED }

/** Not scheduled by default. Only a terminal receipt may consume a source. */
class WindowCycleController(private val storage: WindowCursorStorage, private val clock: () -> Long = System::currentTimeMillis,
    private val cycleStartedAt: Long? = null) {
    suspend fun runCycle(windowKey: String, mode: String, authorizedSourceIds: List<String>, windowEndsAt: Long,
        conditions: () -> CycleConditions, runSource: suspend (String) -> SourceSettlement): String = lock.withLock {
        require(mode in setOf("DEMO","LIVE","OFFLINE_TEST") && authorizedSourceIds.distinct().size == authorizedSourceIds.size)
        val started = cycleStartedAt ?: clock()
        val now=clock()
        require(started<=now)
        if (now >= windowEndsAt || windowEndsAt-now<=35_000) return@withLock "WINDOW_ENDED"
        val remaining=minOf(started+WindowContinuation.AUTOMATIC_BUDGET_MS,windowEndsAt)-now-35_000
        if(remaining<=0) return@withLock "CONTINUE_NEXT_CYCLE"
        val old=storage.load(windowKey,mode)
        val authorized=authorizedSourceIds.toSet()
        // Drop sources whose access was removed, append newly authorized ones;
        // never lose the already settled set when restarting in the same window.
        var cursor=WindowCursor(windowKey,mode,
            ((old?.pending.orEmpty().filter { it in authorized })+authorizedSourceIds).distinct(),old?.finished.orEmpty())
        storage.save(cursor)
        val result=withTimeoutOrNull(remaining) {
            var reason="WINDOW_COMPLETE"
            while (true) {
                val next=WindowContinuation.next(cursor,mode,clock(),started,windowEndsAt,conditions())
                val id=next.id
                if (id==null) { reason=next.reason; break }
                val workBudget=minOf(180_000L,windowEndsAt-clock()-35_000L)
                if(workBudget<=0) { reason="CONTINUE_NEXT_CYCLE";break }
                val settled=withTimeoutOrNull(workBudget) {
                    coroutineScope {
                        val task=async { runSource(id) }
                        val monitor=launch {
                            while(isActive) {
                                delay(2_000)
                                val c=conditions()
                                if((mode=="LIVE"&&!c.screenOn)||!c.wifi||!c.charging||c.thermalSevere||c.batteryPercent==null||c.batteryPercent<20||clock()>=windowEndsAt)
                                    task.cancel(CancellationException("DEVICE_CONSTRAINT_CHANGED"))
                            }
                        }
                        try { task.await() } finally { monitor.cancelAndJoin() }
                    }
                }
                when (settled) {
                    SourceSettlement.SETTLED,SourceSettlement.SETTLED_FAILURE -> {
                        cursor=WindowContinuation.finished(cursor,id);storage.save(cursor)
                    }
                    else -> { reason=if(settled==SourceSettlement.RECONCILIATION_REQUIRED||settled==null) "RECONCILIATION_REQUIRED" else "SOURCE_DEFERRED";break }
                }
            }
            reason
        }
        result ?: "CONTINUE_NEXT_CYCLE"
    }
    companion object { private val lock=Mutex() }
}
