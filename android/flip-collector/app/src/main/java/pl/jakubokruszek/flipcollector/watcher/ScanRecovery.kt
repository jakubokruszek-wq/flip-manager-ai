package pl.jakubokruszek.flipcollector.watcher

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/**
 * Durable note of the scan in progress. Written when a scan starts and after
 * every group, removed when the scan finishes normally. A journal still on
 * disk when no scan runs in this process means the process died mid-scan
 * (killed by Android, crash, reboot, force stop): [ScanRecovery] turns it
 * into an INTERRUPTED history record with the counts of its last checkpoint.
 */
data class ScanJournal(
    val scanId: String,
    val trigger: ScanTrigger,
    val mode: ScanMode,
    val startedAt: String,
    val windowKey: String?,
    val totalGroups: Int,
    val completedGroups: Int,
    val postsSeen: Int,
    val offersFound: Int,
    val postsSent: Int,
    val errors: Int,
    val groupReports: List<GroupReport>,
    val lastCheckpointAt: String,
    /** Group being scanned when the last checkpoint was written. */
    val currentGroup: String? = null,
)

/** What happened to one scan window. */
enum class WindowStatus {
    /** A scan for this window is running (or was, if the process died before finishing). */
    STARTED,
    /** A scan for this window reached its end: completed, partial, failed or timed out. The window is used. */
    FINISHED,
    /** The scan was cut off (process killed, stopped by the system or by the user); a retry may follow. */
    INTERRUPTED,
}

data class WindowEntry(val key: String, val status: WindowStatus, val attempts: Int, val updatedAt: String)

/**
 * Per-window bookkeeping. Distinguishes a window that is used (a scan
 * finished in it), one whose scan was interrupted (one retry allowed while
 * the window is still open) and one whose retries are exhausted.
 */
object WindowLedger {
    /** First attempt plus one retry after an interruption. */
    const val MAX_ATTEMPTS = 2
    private const val KEEP = 30

    fun started(ledger: List<WindowEntry>, key: String, at: Instant): List<WindowEntry> {
        val previous = ledger.firstOrNull { it.key == key }
        return upsert(ledger, WindowEntry(key, WindowStatus.STARTED, (previous?.attempts ?: 0) + 1, at.toString()))
    }

    fun finished(ledger: List<WindowEntry>, key: String, outcome: ScanOutcome, at: Instant): List<WindowEntry> {
        val previous = ledger.firstOrNull { it.key == key } ?: WindowEntry(key, WindowStatus.STARTED, 1, at.toString())
        val status = if (outcome == ScanOutcome.STOPPED || outcome == ScanOutcome.INTERRUPTED) WindowStatus.INTERRUPTED else WindowStatus.FINISHED
        return upsert(ledger, previous.copy(status = status, updatedAt = at.toString()))
    }

    private fun upsert(ledger: List<WindowEntry>, entry: WindowEntry): List<WindowEntry> =
        (listOf(entry) + ledger.filterNot { it.key == entry.key }).take(KEEP)

    fun encode(ledger: List<WindowEntry>): String = JSONArray().apply {
        ledger.forEach { put(JSONObject().put("key", it.key).put("status", it.status.name).put("attempts", it.attempts).put("updatedAt", it.updatedAt)) }
    }.toString()

    fun decode(text: String?): List<WindowEntry> = runCatching {
        val array = JSONArray(text ?: "[]")
        (0 until array.length()).mapNotNull { i ->
            runCatching {
                val json = array.getJSONObject(i)
                WindowEntry(json.getString("key"), WindowStatus.valueOf(json.getString("status")), json.optInt("attempts", 1), json.optString("updatedAt"))
            }.getOrNull()
        }
    }.getOrDefault(emptyList())
}

object ScanRecovery {
    fun journalAt(progress: ScanProgress, base: ScanJournal, reports: List<GroupReport>, at: Instant): ScanJournal = base.copy(
        completedGroups = progress.completedGroups,
        postsSeen = progress.postsSeen,
        offersFound = progress.offersFound,
        postsSent = progress.postsSent,
        errors = progress.errors,
        groupReports = reports,
        lastCheckpointAt = at.toString(),
        currentGroup = progress.currentGroup,
    )

    /** History record for a journal left behind by a dead process. */
    fun interruptedRecord(journal: ScanJournal, detectedAt: Instant): ScanRecord = ScanRecord(
        id = journal.scanId,
        trigger = journal.trigger,
        startedAt = journal.startedAt,
        finishedAt = journal.lastCheckpointAt,
        outcome = ScanOutcome.INTERRUPTED,
        groups = journal.totalGroups,
        postsSeen = journal.postsSeen,
        postsSent = journal.postsSent,
        errors = journal.errors,
        message = "Proces aplikacji zakończył się w trakcie skanu (ukończone grupy: ${journal.completedGroups}/${journal.totalGroups}" +
            (journal.currentGroup?.let { ", przerwana: $it" } ?: "") + ").",
        windowKey = journal.windowKey,
        mode = journal.mode,
        offersFound = journal.offersFound,
        groupReports = journal.groupReports,
        stopReason = "Wykryto przy następnym uruchomieniu: ${detectedAt}",
    )

    fun encode(journal: ScanJournal): String = JSONObject()
        .put("scanId", journal.scanId)
        .put("trigger", journal.trigger.name)
        .put("mode", journal.mode.name)
        .put("startedAt", journal.startedAt)
        .put("windowKey", journal.windowKey ?: JSONObject.NULL)
        .put("totalGroups", journal.totalGroups)
        .put("completedGroups", journal.completedGroups)
        .put("postsSeen", journal.postsSeen)
        .put("offersFound", journal.offersFound)
        .put("postsSent", journal.postsSent)
        .put("errors", journal.errors)
        .put("groupReports", JSONArray().apply {
            journal.groupReports.forEach { put(JSONObject().put("groupName", it.groupName).put("postsSeen", it.postsSeen).put("offersFound", it.offersFound).put("error", it.error ?: JSONObject.NULL)) }
        })
        .put("lastCheckpointAt", journal.lastCheckpointAt)
        .put("currentGroup", journal.currentGroup ?: JSONObject.NULL)
        .toString()

    fun decode(text: String?): ScanJournal? = runCatching {
        if (text.isNullOrBlank()) return null
        val json = JSONObject(text)
        val reports = json.optJSONArray("groupReports")
        ScanJournal(
            scanId = json.getString("scanId"),
            trigger = ScanTrigger.valueOf(json.getString("trigger")),
            mode = ScanMode.valueOf(json.getString("mode")),
            startedAt = json.getString("startedAt"),
            windowKey = if (json.isNull("windowKey")) null else json.getString("windowKey"),
            totalGroups = json.optInt("totalGroups"),
            completedGroups = json.optInt("completedGroups"),
            postsSeen = json.optInt("postsSeen"),
            offersFound = json.optInt("offersFound"),
            postsSent = json.optInt("postsSent"),
            errors = json.optInt("errors"),
            groupReports = if (reports == null) emptyList() else (0 until reports.length()).map { i ->
                val r = reports.getJSONObject(i)
                GroupReport(r.getString("groupName"), r.optInt("postsSeen"), r.optInt("offersFound"), if (r.isNull("error")) null else r.getString("error"))
            },
            lastCheckpointAt = json.getString("lastCheckpointAt"),
            currentGroup = if (json.isNull("currentGroup")) null else json.getString("currentGroup"),
        )
    }.getOrNull()
}
