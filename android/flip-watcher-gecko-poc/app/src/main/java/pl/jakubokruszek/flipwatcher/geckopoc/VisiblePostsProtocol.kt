package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject

/** Strict allowlist: neither text, URLs nor IDs can enter the local report. */
object VisiblePostsProtocol {
    val keys = listOf("candidates", "semanticCandidates", "heuristicCandidates", "links", "confirmedIds", "permalinks", "priceCandidates", "areaCandidates", "roomCandidates", "districtCandidates", "photoCandidates", "visibleTextBlocks", "desktopMessageBlocks", "mobileTextBlocks", "fallbackTextBlocks", "ambiguousCards")
    fun report(reply: JSONObject, nonce: String): String? {
        if (reply.optString("type") != "visiblePostsResult" || reply.optString("nonce") != nonce || reply.optString("status") != "GROUP_OK") return null
        if (reply.keys().asSequence().toSet() != setOf("type", "nonce", "status", "counts")) return null
        val counts = reply.optJSONObject("counts") ?: return null
        if (counts.keys().asSequence().toSet() != keys.toSet()) return null
        if (keys.any { counts.opt(it) !is Int || counts.getInt(it) !in 0..2000 }) return null
        if (counts.getInt("candidates") > 20 || counts.getInt("semanticCandidates") + counts.getInt("heuristicCandidates") != counts.getInt("candidates")) return null
        return "DOM 0.2.6 • tylko lokalnie\n" + keys.joinToString("\n") { "$it: ${counts.getInt(it)}" } +
            "\nPotwierdzone: ID z dokładnych linków grupy. Pola i mobilne kontenery: heurystyki, bez potwierdzenia oferty."
    }
}
