package pl.jakubokruszek.flipcollector.watcher

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.NonCancellable
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

data class GroupScanResult(val postsSeen: Int, val postsSent: Int)

/** One group's work. The live implementation will drive the WebView; this stage ships only [DryRunScanExecutor]. */
interface ScanExecutor {
    /** True when the executor never touches Facebook or the job queue. */
    val dryRun: Boolean
    suspend fun scanGroup(group: WatchedGroup, onProgress: (postsSeen: Int, postsSent: Int) -> Unit): GroupScanResult
}

/** Walks the selected groups without opening Facebook, so the screen, counters and history can be tested end to end. */
class DryRunScanExecutor(private val pause: suspend () -> Unit = {}) : ScanExecutor {
    override val dryRun = true
    override suspend fun scanGroup(group: WatchedGroup, onProgress: (Int, Int) -> Unit): GroupScanResult {
        pause()
        onProgress(0, 0)
        return GroupScanResult(postsSeen = 0, postsSent = 0)
    }
}

sealed interface ScanState {
    data object Idle : ScanState
    data class Running(val scanId: String, val trigger: ScanTrigger, val progress: ScanProgress) : ScanState
}

sealed interface StartResult {
    data class Started(val scanId: String) : StartResult
    data object AlreadyRunning : StartResult
}

/**
 * Runs at most one scan at a time. A second start while a scan runs is
 * refused, never queued: the server lease also allows one job per device.
 * Each group's failure is counted and the scan moves on; only cancellation
 * (Zatrzymaj) ends it early.
 */
class ScanCoordinator(
    private val scope: CoroutineScope,
    private val executor: ScanExecutor,
    private val onFinished: (ScanRecord) -> Unit,
    private val clock: () -> Instant = Instant::now,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    private val running = AtomicBoolean(false)
    private val mutableState = MutableStateFlow<ScanState>(ScanState.Idle)
    val state: StateFlow<ScanState> = mutableState.asStateFlow()

    @Volatile private var job: Job? = null

    fun start(trigger: ScanTrigger, groups: List<WatchedGroup>, windowKey: String? = null): StartResult {
        if (!running.compareAndSet(false, true)) return StartResult.AlreadyRunning
        val scanId = newId()
        val startedAt = clock()
        var progress = ScanProgress(totalGroups = groups.size)
        var lastError: String? = null
        mutableState.value = ScanState.Running(scanId, trigger, progress)
        // Lazy start: [job] is set before the body can run, so a scan that
        // finishes at once never leaves a stale job behind.
        val launched = scope.launch(start = CoroutineStart.LAZY) {
            val self = coroutineContext[Job]
            var outcome: ScanOutcome? = null
            try {
                for (group in groups) {
                    progress = progress.copy(currentGroup = group.name)
                    mutableState.value = ScanState.Running(scanId, trigger, progress)
                    try {
                        val base = progress
                        val result = executor.scanGroup(group) { seen, sent ->
                            mutableState.value = ScanState.Running(scanId, trigger, base.copy(postsSeen = base.postsSeen + seen, postsSent = base.postsSent + sent))
                        }
                        progress = base.copy(completedGroups = base.completedGroups + 1, postsSeen = base.postsSeen + result.postsSeen, postsSent = base.postsSent + result.postsSent)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        lastError = "${group.name}: ${safeMessage(error)}"
                        progress = progress.copy(completedGroups = progress.completedGroups + 1, errors = progress.errors + 1)
                    }
                    mutableState.value = ScanState.Running(scanId, trigger, progress)
                }
                outcome = when {
                    groups.isNotEmpty() && progress.errors == groups.size -> ScanOutcome.FAILED
                    progress.errors > 0 -> ScanOutcome.PARTIAL
                    executor.dryRun -> ScanOutcome.DRY_RUN
                    else -> ScanOutcome.COMPLETED
                }
            } catch (cancelled: CancellationException) {
                outcome = ScanOutcome.STOPPED
                throw cancelled
            } finally {
                withContext(NonCancellable) {
                    val record = ScanRecord(
                        id = scanId,
                        trigger = trigger,
                        startedAt = startedAt.toString(),
                        finishedAt = clock().toString(),
                        outcome = outcome ?: ScanOutcome.STOPPED,
                        groups = groups.size,
                        postsSeen = progress.postsSeen,
                        postsSent = progress.postsSent,
                        errors = progress.errors,
                        message = lastError ?: if (executor.dryRun) "Tryb przygotowawczy: Facebook nie był otwierany." else null,
                        windowKey = windowKey,
                    )
                    runCatching { onFinished(record) }
                    mutableState.value = ScanState.Idle
                    if (job === self) job = null
                    running.set(false)
                }
            }
        }
        job = launched
        launched.start()
        return StartResult.Started(scanId)
    }

    /** Cancels the running scan; it is recorded as STOPPED. Returns false when nothing runs. */
    fun stop(): Boolean {
        val current = job ?: return false
        current.cancel(CancellationException("Zatrzymane przez użytkownika"))
        return true
    }

    val isRunning: Boolean get() = running.get()

    private fun safeMessage(error: Exception): String = (error.message ?: error::class.java.simpleName).take(200)
}
