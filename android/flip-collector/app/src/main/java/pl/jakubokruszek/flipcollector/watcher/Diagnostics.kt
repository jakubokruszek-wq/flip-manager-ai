package pl.jakubokruszek.flipcollector.watcher

import org.json.JSONArray
import org.json.JSONObject

enum class DiagnosticLevel { INFO, WARN, ERROR }

/**
 * One line of the local diagnostic log. Codes are stable identifiers for
 * filtering; messages are short Polish text. Never put a token, cookie, URL
 * query or post content in here: the log can be copied out of the app.
 */
data class DiagnosticEvent(val at: String, val level: DiagnosticLevel, val code: String, val message: String)

object Diagnostics {
    const val LIMIT = 200

    /** Newest first, capped at [LIMIT]; messages are cut to 300 characters. */
    fun append(log: List<DiagnosticEvent>, event: DiagnosticEvent): List<DiagnosticEvent> =
        (listOf(event.copy(message = event.message.take(300))) + log).take(LIMIT)

    fun encode(log: List<DiagnosticEvent>): String = JSONArray().apply {
        log.take(LIMIT).forEach { put(JSONObject().put("at", it.at).put("level", it.level.name).put("code", it.code).put("message", it.message)) }
    }.toString()

    fun decode(text: String?): List<DiagnosticEvent> = runCatching {
        val array = JSONArray(text ?: "[]")
        (0 until array.length()).mapNotNull { index ->
            runCatching {
                val json = array.getJSONObject(index)
                DiagnosticEvent(json.getString("at"), DiagnosticLevel.valueOf(json.getString("level")), json.getString("code"), json.getString("message"))
            }.getOrNull()
        }
    }.getOrDefault(emptyList())

    /** Plain text for "Kopiuj diagnostykę", oldest first so it reads as a timeline. */
    fun export(log: List<DiagnosticEvent>, header: List<String>): String = buildString {
        header.forEach { appendLine(it) }
        appendLine("---")
        log.asReversed().forEach { appendLine("${it.at} ${it.level} ${it.code} ${it.message}") }
    }
}
