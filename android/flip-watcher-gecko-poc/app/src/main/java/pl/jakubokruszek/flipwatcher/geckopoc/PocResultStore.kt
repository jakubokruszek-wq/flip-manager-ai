package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** One stored run: a manual scan of the group or a screen-off fixture test. */
data class StoredRun(
    val kind: String,
    val startedAt: String,
    val finishedAt: String,
    val status: String,
    val postIds: List<String>,
    val permalinks: List<String>,
    val rejectedByApp: Int,
    val notes: Map<String, String> = emptyMap(),
)

/**
 * Isolated, local-only storage of POC results: one JSON file in this app's own
 * private directory (its own package, so no other app — including the
 * existing Watcher — can read or write it). Only post ids, permalinks and
 * counters are kept; no post text, author, image, cookie or token. Nothing is
 * ever uploaded: the POC has no network client.
 */
class PocResultStore(private val directory: File) {
    private val file get() = File(directory, FILE_NAME)

    @Synchronized
    fun runs(): List<StoredRun> = runCatching { decode(file.readText()) }.getOrDefault(emptyList())

    @Synchronized
    fun append(run: StoredRun) {
        directory.mkdirs()
        val updated = (listOf(run) + runs()).take(LIMIT)
        val temp = File(directory, "$FILE_NAME.tmp")
        temp.writeText(encode(updated))
        check(temp.renameTo(file) || run { file.delete(); temp.renameTo(file) }) { "Nie udało się zapisać wyników POC" }
    }

    @Synchronized
    fun clear() { file.delete() }

    companion object {
        const val DIRECTORY = "gecko-poc"
        const val FILE_NAME = "poc-results.json"
        const val LIMIT = 30

        fun encode(runs: List<StoredRun>): String = JSONArray(runs.map { run ->
            JSONObject()
                .put("kind", run.kind)
                .put("startedAt", run.startedAt)
                .put("finishedAt", run.finishedAt)
                .put("status", run.status)
                .put("postIds", JSONArray(run.postIds))
                .put("permalinks", JSONArray(run.permalinks))
                .put("rejectedByApp", run.rejectedByApp)
                .put("notes", JSONObject(run.notes))
        }).toString()

        fun decode(text: String): List<StoredRun> {
            val array = JSONArray(text)
            return (0 until array.length()).mapNotNull { index ->
                val item = array.optJSONObject(index) ?: return@mapNotNull null
                val notes = item.optJSONObject("notes")
                StoredRun(
                    kind = item.optString("kind"),
                    startedAt = item.optString("startedAt"),
                    finishedAt = item.optString("finishedAt"),
                    status = item.optString("status"),
                    postIds = strings(item.optJSONArray("postIds")),
                    permalinks = strings(item.optJSONArray("permalinks")),
                    rejectedByApp = item.optInt("rejectedByApp"),
                    notes = notes?.keys()?.asSequence()?.associateWith { notes.optString(it) } ?: emptyMap(),
                )
            }
        }

        fun fromReport(kind: String, startedAt: String, finishedAt: String, report: ScanReport, notes: Map<String, String> = emptyMap()) = StoredRun(
            kind = kind,
            startedAt = startedAt,
            finishedAt = finishedAt,
            status = report.status.name,
            postIds = report.posts.map { it.postId },
            permalinks = report.posts.map { it.permalink },
            rejectedByApp = report.rejectedByApp,
            notes = notes,
        )

        private fun strings(array: JSONArray?): List<String> = if (array == null) emptyList() else (0 until array.length()).map { array.optString(it) }
    }
}
