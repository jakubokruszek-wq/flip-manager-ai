package pl.jakubokruszek.flipcollector.watcher

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.time.Duration
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Time limits of one scan. A group over [perGroup] is counted as an error
 * and the scan moves on; a scan over [total] ends as TIMED_OUT. The
 * automatic scan's total stays under WorkManager's per-worker execution
 * limit, so the system never has to kill it mid-write.
 */
data class ScanLimits(val perGroup: Duration, val total: Duration) {
    companion object {
        val MANUAL = ScanLimits(perGroup = Duration.ofMinutes(3), total = Duration.ofMinutes(20))
        val AUTOMATIC = ScanLimits(perGroup = Duration.ofMinutes(3), total = Duration.ofMinutes(8))
    }
}

sealed interface ScanState {
    data object Idle : ScanState
    data class Running(val scanId: String, val trigger: ScanTrigger, val mode: ScanMode, val progress: ScanProgress) : ScanState
}

sealed interface StartResult {
    data class Started(val scanId: String) : StartResult
    data object AlreadyRunning : StartResult
}

/**
 * Runs at most one scan at a time. A second start while a scan runs is
 * refused, never queued: the server lease also allows one job per device.
 * Each group's failure or timeout is counted and the scan moves on; only
 * [stop] (or the total limit) ends it early.
 */
class ScanCoordinator(
    private val scope: CoroutineScope,
    private val onFinished: (ScanRecord) -> Unit,
    /** Durable checkpoint at start, at each group's start and after each group; see [ScanJournal]. */
    private val onCheckpoint: (ScanJournal) -> Unit = {},
    private val clock: () -> Instant = Instant::now,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    private val running = AtomicBoolean(false)
    private val mutableState = MutableStateFlow<ScanState>(ScanState.Idle)
    val state: StateFlow<ScanState> = mutableState.asStateFlow()

    @Volatile private var job: Job? = null
    @Volatile private var stopReason: String? = null

    fun start(
        trigger: ScanTrigger,
        groups: List<WatchedGroup>,
        executor: ScanExecutor,
        limits: ScanLimits = if (trigger == ScanTrigger.AUTOMATIC) ScanLimits.AUTOMATIC else ScanLimits.MANUAL,
        windowKey: String? = null,
    ): StartResult {
        if (!running.compareAndSet(false, true)) return StartResult.AlreadyRunning
        val scanId = newId()
        val startedAt = clock()
        val mode = executor.mode
        stopReason = null
        var progress = ScanProgress(totalGroups = groups.size)
        val reports = mutableListOf<GroupReport>()
        fun publish(value: ScanProgress) { mutableState.value = ScanState.Running(scanId, trigger, mode, value) }
        val journalBase = ScanJournal(scanId, trigger, mode, startedAt.toString(), windowKey, groups.size, 0, 0, 0, 0, 0, emptyList(), startedAt.toString())
        fun checkpoint() { runCatching { onCheckpoint(ScanRecovery.journalAt(progress, journalBase, reports.toList(), clock())) } }
        publish(progress)
        checkpoint()
        // Lazy start: [job] is set before the body can run, so a scan that
        // finishes at once never leaves a stale job behind.
        val launched = scope.launch(start = CoroutineStart.LAZY) {
            val self = coroutineContext[Job]
            var outcome: ScanOutcome? = null
            try {
                val finished = withTimeoutOrNull(limits.total.toMillis()) {
                    for (group in groups) {
                        val base = progress.copy(currentGroup = group.name, currentGroupPosts = 0, currentGroupTotal = null)
                        progress = base
                        publish(progress)
                        checkpoint()
                        try {
                            val result = withTimeoutOrNull(limits.perGroup.toMillis()) {
                                executor.scanGroup(group) { step ->
                                    publish(base.copy(postsSeen = base.postsSeen + step.postsSeen, offersFound = base.offersFound + step.offersFound, currentGroupPosts = step.postsSeen, currentGroupTotal = step.totalPosts))
                                }
                            }
                            if (result == null) {
                                reports += GroupReport(group.name, 0, 0, "Przekroczono limit czasu grupy (${limits.perGroup.toMinutes()} min)")
                                progress = base.copy(completedGroups = base.completedGroups + 1, errors = base.errors + 1)
                            } else {
                                reports += GroupReport(group.name, result.postsSeen, result.offersFound)
                                progress = base.copy(completedGroups = base.completedGroups + 1, postsSeen = base.postsSeen + result.postsSeen, offersFound = base.offersFound + result.offersFound, postsSent = base.postsSent + result.postsSent)
                            }
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (error: Exception) {
                            reports += GroupReport(group.name, 0, 0, safeMessage(error))
                            progress = base.copy(completedGroups = base.completedGroups + 1, errors = base.errors + 1)
                        }
                        progress = progress.copy(currentGroup = null)
                        publish(progress)
                        checkpoint()
                    }
                    true
                }
                outcome = when {
                    finished == null -> ScanOutcome.TIMED_OUT
                    groups.isNotEmpty() && progress.errors == groups.size -> ScanOutcome.FAILED
                    progress.errors > 0 -> ScanOutcome.PARTIAL
                    else -> ScanOutcome.COMPLETED
                }
            } catch (cancelled: CancellationException) {
                outcome = ScanOutcome.STOPPED
                throw cancelled
            } finally {
                withContext(NonCancellable) {
                    val firstError = reports.firstOrNull { it.error != null }
                    val finalOutcome = outcome ?: ScanOutcome.STOPPED
                    val record = ScanRecord(
                        id = scanId,
                        trigger = trigger,
                        startedAt = startedAt.toString(),
                        finishedAt = clock().toString(),
                        outcome = finalOutcome,
                        groups = groups.size,
                        postsSeen = progress.postsSeen,
                        postsSent = progress.postsSent,
                        errors = progress.errors,
                        message = when {
                            finalOutcome == ScanOutcome.TIMED_OUT -> "Skan przerwany po ${limits.total.toMinutes()} min (limit całkowity)."
                            firstError != null -> "${firstError.groupName}: ${firstError.error}"
                            mode == ScanMode.DEMO -> "Tryb demo: dane testowe, nic nie wysłano do Flip Managera."
                            else -> null
                        },
                        windowKey = windowKey,
                        mode = mode,
                        offersFound = progress.offersFound,
                        groupReports = reports.toList(),
                        stopReason = if (finalOutcome == ScanOutcome.STOPPED) stopReason ?: "Anulowano" else null,
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

    /** Cancels the running scan; it is recorded as STOPPED with [reason]. Returns false when nothing runs. */
    fun stop(reason: String = "Zatrzymane przez użytkownika"): Boolean {
        val current = job ?: return false
        stopReason = reason
        current.cancel(CancellationException(reason))
        return true
    }

    val isRunning: Boolean get() = running.get()

    private fun safeMessage(error: Exception): String = (error.message ?: error::class.java.simpleName).take(200)
}
