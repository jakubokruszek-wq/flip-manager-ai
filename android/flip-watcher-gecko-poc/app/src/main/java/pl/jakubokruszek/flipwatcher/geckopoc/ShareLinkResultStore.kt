package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context

/** Separate private namespace; never touches the old scan journal, outbox or session preferences. */
class ShareLinkResultStore(context: Context) {
    private val preferences = context.getSharedPreferences("share_link_terminal_result_v1", Context.MODE_PRIVATE)
    fun read(): ShareLinkResult? = runCatching { ShareLinkResult.decode(preferences.getString("last", null)) }.getOrNull()
    fun save(result: ShareLinkResult): Boolean = runCatching { preferences.edit().putString("last", result.encode()).commit() }.getOrDefault(false)
}
