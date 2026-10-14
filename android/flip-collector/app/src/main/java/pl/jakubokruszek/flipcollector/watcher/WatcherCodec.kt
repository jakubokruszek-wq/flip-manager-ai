package pl.jakubokruszek.flipcollector.watcher

import org.json.JSONArray
import org.json.JSONObject
import java.time.DayOfWeek
import java.time.ZoneId

/** JSON form of the locally stored watcher state. Unknown or broken input falls back to defaults. */
object WatcherCodec {
    const val HISTORY_LIMIT = 50

    fun encodeSchedule(schedule: ScanSchedule): String = JSONObject()
        .put("enabled", schedule.enabled)
        .put("startMinutes", schedule.startMinutes)
        .put("endMinutes", schedule.endMinutes)
        .put("days", JSONArray().apply { schedule.days.sorted().forEach { put(it.name) } })
        .put("requireWifi", schedule.requireWifi)
        .put("requireCharging", schedule.requireCharging)
        .put("zone", schedule.zone.id)
        .toString()

    fun decodeSchedule(text: String?): ScanSchedule = runCatching {
        if (text.isNullOrBlank()) return ScanSchedule.DEFAULT
        val json = JSONObject(text)
        val days = json.optJSONArray("days")?.let { array ->
            (0 until array.length()).mapNotNull { index -> runCatching { DayOfWeek.valueOf(array.getString(index)) }.getOrNull() }.toSet()
        } ?: ScanSchedule.DEFAULT.days
        ScanSchedule(
            enabled = json.optBoolean("enabled", ScanSchedule.DEFAULT.enabled),
            startMinutes = json.optInt("startMinutes", ScanSchedule.DEFAULT.startMinutes),
            endMinutes = json.optInt("endMinutes", ScanSchedule.DEFAULT.endMinutes),
            days = days,
            requireWifi = json.optBoolean("requireWifi", ScanSchedule.DEFAULT.requireWifi),
            requireCharging = json.optBoolean("requireCharging", ScanSchedule.DEFAULT.requireCharging),
            zone = runCatching { ZoneId.of(json.optString("zone", WARSAW.id)) }.getOrDefault(WARSAW),
        )
    }.getOrDefault(ScanSchedule.DEFAULT)

    fun encodeGroups(groups: List<WatchedGroup>): String = JSONArray().apply {
        groups.forEach { put(JSONObject().put("id", it.id).put("name", it.name).put("url", it.url).put("active", it.active)) }
    }.toString()

    fun decodeGroups(text: String?): List<WatchedGroup> = runCatching {
        val array = JSONArray(text ?: "[]")
        (0 until array.length()).map { index ->
            val json = array.getJSONObject(index)
            WatchedGroup(json.getString("id"), json.getString("name"), json.getString("url"), json.optBoolean("active", true))
        }
    }.getOrDefault(emptyList())

    fun encodeSelection(selection: GroupSelection): String = when (selection) {
        GroupSelection.AllActive -> "ALL"
        is GroupSelection.Single -> "ONE:${selection.groupId}"
    }

    fun decodeSelection(text: String?): GroupSelection =
        if (text != null && text.startsWith("ONE:") && text.length > 4) GroupSelection.Single(text.removePrefix("ONE:")) else GroupSelection.AllActive

    fun encodeHistory(records: List<ScanRecord>): String = JSONArray().apply {
        records.take(HISTORY_LIMIT).forEach { record ->
            put(
                JSONObject()
                    .put("id", record.id)
                    .put("trigger", record.trigger.name)
                    .put("startedAt", record.startedAt)
                    .put("finishedAt", record.finishedAt)
                    .put("outcome", record.outcome.name)
                    .put("groups", record.groups)
                    .put("postsSeen", record.postsSeen)
                    .put("postsSent", record.postsSent)
                    .put("errors", record.errors)
                    .put("message", record.message ?: JSONObject.NULL)
                    .put("windowKey", record.windowKey ?: JSONObject.NULL),
            )
        }
    }.toString()

    fun decodeHistory(text: String?): List<ScanRecord> = runCatching {
        val array = JSONArray(text ?: "[]")
        (0 until array.length()).mapNotNull { index ->
            runCatching {
                val json = array.getJSONObject(index)
                ScanRecord(
                    id = json.getString("id"),
                    trigger = ScanTrigger.valueOf(json.getString("trigger")),
                    startedAt = json.getString("startedAt"),
                    finishedAt = json.getString("finishedAt"),
                    outcome = ScanOutcome.valueOf(json.getString("outcome")),
                    groups = json.optInt("groups"),
                    postsSeen = json.optInt("postsSeen"),
                    postsSent = json.optInt("postsSent"),
                    errors = json.optInt("errors"),
                    message = if (json.isNull("message")) null else json.optString("message"),
                    windowKey = if (json.isNull("windowKey")) null else json.optString("windowKey"),
                )
            }.getOrNull()
        }
    }.getOrDefault(emptyList())

    /** Newest first, capped at [HISTORY_LIMIT]. */
    fun prepend(history: List<ScanRecord>, record: ScanRecord): List<ScanRecord> =
        (listOf(record) + history.filterNot { it.id == record.id }).take(HISTORY_LIMIT)
}
