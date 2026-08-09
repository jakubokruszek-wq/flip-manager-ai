package pl.jakubokruszek.flipcollector

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

class PendingImportStore(context: Context) {
    private val preferences = context.getSharedPreferences("flip_collector_queue", Context.MODE_PRIVATE)

    fun enqueue(draft: FacebookImportDraft) {
        val queue = read().filterNot { it.idempotencyKey == draft.idempotencyKey } + draft
        write(queue)
    }

    fun remove(idempotencyKey: String) = write(read().filterNot { it.idempotencyKey == idempotencyKey })

    fun all(): List<FacebookImportDraft> = read()

    private fun read(): List<FacebookImportDraft> = runCatching {
        val array = JSONArray(preferences.getString(KEY_QUEUE, "[]"))
        List(array.length()) { index -> array.getJSONObject(index).toDraft() }
    }.getOrDefault(emptyList())

    private fun write(queue: List<FacebookImportDraft>) {
        val array = JSONArray().apply { queue.forEach { put(it.toJson()) } }
        preferences.edit().putString(KEY_QUEUE, array.toString()).apply()
    }

    private fun FacebookImportDraft.toJson(): JSONObject = JSONObject()
        .put("sourcePostUrl", sourcePostUrl)
        .put("title", title)
        .put("groupName", groupName)
        .put("content", content)
        .put("price", price)
        .put("area", area)
        .put("rooms", rooms)
        .put("location", location)
        .put("collectedAt", collectedAt)
        .put("idempotencyKey", idempotencyKey)

    private fun JSONObject.toDraft() = FacebookImportDraft(
        sourcePostUrl = getString("sourcePostUrl"),
        title = optString("title").ifBlank { null },
        groupName = optString("groupName").ifBlank { null },
        content = optString("content").ifBlank { null },
        price = optString("price"),
        area = optString("area"),
        rooms = optString("rooms"),
        location = optString("location"),
        collectedAt = getString("collectedAt"),
        idempotencyKey = getString("idempotencyKey"),
    )

    companion object {
        private const val KEY_QUEUE = "pending_imports"
    }
}
