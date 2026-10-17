package pl.jakubokruszek.flipcollector.integration

import pl.jakubokruszek.flipcollector.watcher.WatchedGroup

/**
 * Group list as the app needs it from Flip Manager, independent of the wire
 * format. The backend contract (Codex) decides the endpoint, auth and JSON;
 * its client will map that response onto [RemoteGroup]. Nothing here assumes
 * a URL, field name or status code.
 */
data class RemoteGroup(
    /** Stable server-side identifier of the watched group. */
    val remoteId: String,
    val name: String,
    val url: String,
    /** Whether Flip Manager wants this group watched. */
    val enabled: Boolean,
)

/** Where a group in the phone's list comes from. */
enum class GroupOrigin { LOCAL, SERVER, REMOVED_ON_SERVER }

/** A group in the phone's list with its sync metadata. */
data class SyncedGroup(
    val group: WatchedGroup,
    val origin: GroupOrigin,
    val remoteId: String? = null,
    /** The server's enabled flag; the phone's own on/off lives in [WatchedGroup.active]. */
    val serverEnabled: Boolean = true,
) {
    /** Scanned only when both the phone and Flip Manager agree. */
    val scannable: Boolean get() = group.active && serverEnabled && origin != GroupOrigin.REMOVED_ON_SERVER
}

sealed interface GroupFetchResult {
    data class Success(val groups: List<RemoteGroup>) : GroupFetchResult
    /** No client yet: the contract is not in the repository. */
    data object PendingContract : GroupFetchResult
    data class Failure(val code: String) : GroupFetchResult
}

/** Source of the server group list. Implemented once the contract exists. */
fun interface GroupSource {
    suspend fun fetch(): GroupFetchResult
}

/** The only source in this release: it never calls the network. */
object PendingContractGroupSource : GroupSource {
    override suspend fun fetch(): GroupFetchResult = GroupFetchResult.PendingContract
}

data class GroupSyncReport(val added: Int, val updated: Int, val removedOnServer: Int, val unchanged: Int)

/**
 * Merges the server list into the phone's list:
 *
 * - matching is by remote id, then by normalised URL (a group added by hand
 *   before sync becomes the server's group, keeping the phone's on/off);
 * - the server owns name, URL and its enabled flag;
 * - the phone owns its own on/off switch, which survives every sync;
 * - a server group missing from the response is kept but marked
 *   REMOVED_ON_SERVER and never scanned (nothing disappears silently);
 * - groups added only on the phone stay LOCAL;
 * - a group that reappears on the server becomes SERVER again.
 *
 * Order: server order first, then local-only groups, then removed ones.
 */
object GroupSync {
    fun normalizeUrl(url: String): String = url.trim()
        .replace(Regex("^https?://(m\\.|www\\.)?facebook\\.com/", RegexOption.IGNORE_CASE), "https://www.facebook.com/")
        .trimEnd('/')
        .lowercase()

    fun merge(local: List<SyncedGroup>, remote: List<RemoteGroup>, newId: (RemoteGroup) -> String): Pair<List<SyncedGroup>, GroupSyncReport> {
        val byRemoteId = local.filter { it.remoteId != null }.associateBy { it.remoteId!! }
        val byUrl = local.associateBy { normalizeUrl(it.group.url) }
        val consumed = mutableSetOf<SyncedGroup>()
        var added = 0
        var updated = 0
        var unchanged = 0
        val fromServer = remote.distinctBy { it.remoteId }.map { r ->
            val match = byRemoteId[r.remoteId] ?: byUrl[normalizeUrl(r.url)]?.takeIf { it !in consumed && (it.remoteId == null || it.remoteId == r.remoteId) }
            if (match != null) {
                consumed += match
                val merged = SyncedGroup(
                    group = match.group.copy(name = r.name, url = r.url),
                    origin = GroupOrigin.SERVER,
                    remoteId = r.remoteId,
                    serverEnabled = r.enabled,
                )
                if (merged == match) unchanged++ else updated++
                merged
            } else {
                added++
                SyncedGroup(WatchedGroup(newId(r), r.name, r.url, active = true), GroupOrigin.SERVER, r.remoteId, r.enabled)
            }
        }
        val leftovers = local.filter { it !in consumed }
        val localOnly = leftovers.filter { it.remoteId == null }
        val removed = leftovers.filter { it.remoteId != null }.map { it.copy(origin = GroupOrigin.REMOVED_ON_SERVER) }
        val newlyRemoved = leftovers.count { it.remoteId != null && it.origin != GroupOrigin.REMOVED_ON_SERVER }
        return (fromServer + localOnly + removed) to GroupSyncReport(added, updated, newlyRemoved, unchanged)
    }
}
