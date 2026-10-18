package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONArray
import org.json.JSONObject

/** States the content script can report. Anything else is treated as a protocol error. */
enum class ScanStatus {
    OK, NO_POSTS, LOGIN_REQUIRED, CHECKPOINT, CAPTCHA, GROUP_UNAVAILABLE, WRONG_GROUP, NAVIGATED_AWAY, BUSY, COLLECTOR_ERROR,
    /** App-side outcomes. */
    TIMEOUT, PORT_CLOSED, NOT_READY, PROTOCOL_ERROR;

    /** A stop that must halt any automation until the operator looks at the session. */
    val haltsAutomation: Boolean get() = this in setOf(LOGIN_REQUIRED, CHECKPOINT, CAPTCHA, GROUP_UNAVAILABLE, WRONG_GROUP, NAVIGATED_AWAY)
}

data class FoundPost(val postId: String, val permalink: String, val idSource: String)

data class PageProbe(
    val host: String,
    val path: String,
    val title: String,
    val readyState: String,
    val elements: Int,
    val forms: Int,
    val inputs: Int,
    val passwordInputs: Int,
    val articles: Int,
    val iframes: Int,
)

/** A manual, count-only DOM read; no post identifiers or links are transferred. */
data class DomDiagnosis(val status: String, val counts: Map<String, Int>, val probe: PageProbe?)

data class ScanReport(
    val status: ScanStatus,
    val posts: List<FoundPost>,
    /** Posts the app itself refused: bad id, foreign permalink, duplicate or over the limit. */
    val rejectedByApp: Int,
    val diagnostics: Map<String, Int>,
    val scrolls: Int,
    val probe: PageProbe?,
    val error: String? = null,
)

data class ScanRequest(
    val nonce: String,
    val groupId: String = PocPolicy.APPROVED_GROUP_ID,
    val maxPosts: Int = PocPolicy.MAX_POSTS,
    val scrolls: Int = 0,
    val scrollPauseMs: Int = 1500,
    val allowLoopback: Boolean = false,
    /** Verified slugs of [groupId] only (PocPolicy.VERIFIED_ALIASES); empty unless confirmed. */
    val aliases: List<String> = PocPolicy.aliasesFor(groupId),
) {
    fun toJson(): JSONObject = JSONObject()
        .put("type", "scan")
        .put("nonce", nonce)
        .put("groupId", groupId)
        .put("maxPosts", maxPosts.coerceIn(1, PocPolicy.MAX_POSTS))
        .put("scrolls", scrolls.coerceIn(0, 5))
        .put("scrollPauseMs", scrollPauseMs)
        .put("allowLoopback", allowLoopback)
        .put("aliases", JSONArray(aliases.take(5)))
}

/**
 * The app never trusts the page: every reply from the content script is
 * re-validated here. Only numeric ids with the exact canonical permalink of
 * the requested group survive; duplicates and anything over 20 are dropped.
 */
object ScanProtocol {
    const val MAX_MESSAGE_CHARS = 200_000
    private val POST_ID = Regex("^\\d{5,30}$")

    fun probeRequest(nonce: String): JSONObject = JSONObject().put("type", "probe").put("nonce", nonce)

    fun groupProbeRequest(nonce: String): JSONObject = JSONObject().put("type", "groupProbe").put("nonce", nonce)

    fun domDiagnosisRequest(nonce: String): JSONObject = JSONObject()
        .put("type", "domDiagnosis").put("nonce", nonce)
        .put("groupId", PocPolicy.APPROVED_GROUP_ID)

    private val DOM_COUNT_FIELDS = listOf(
        "anchorsSeen", "exactGroupLinks", "exactGroupIds", "foreignGroupLinks",
        "photoLinks", "otherLinks", "roleArticles", "nativeArticles", "roleFeeds",
        "candidateWrappers", "structuredScripts",
        "iframeCount", "iframeReadable", "iframeInaccessible", "iframeAnchors",
        "iframeArticles", "openShadowRoots", "openShadowAnchors", "openShadowArticles"
    )

    fun parseDomDiagnosis(message: Any?, nonce: String): DomDiagnosis? {
        val json = asJson(message) ?: return null
        if (json.optString("type") != "domDiagnosisResult" || json.optString("nonce") != nonce) return null
        val status = json.optString("status")
        if (status !in setOf("GROUP_OK", "WRONG_GROUP", "LOGIN_REQUIRED", "CHECKPOINT",
                "CAPTCHA", "GROUP_UNAVAILABLE", "NOT_READY")) return null
        val values = json.optJSONObject("counters") ?: return null
        val counts = DOM_COUNT_FIELDS.associateWith { name -> values.optInt(name, 0).coerceIn(0, 9999) }
        return DomDiagnosis(status, counts, parseProbe(json.optJSONObject("probe")))
    }


    /** Group segment of the shown page and the numeric ids Facebook published for it. */
    fun parseGroupProbe(json: JSONObject?): Pair<String?, List<GroupIdHit>>? {
        val group = json?.optJSONObject("group") ?: return null
        val ids = group.optJSONArray("ids") ?: JSONArray()
        val hits = (0 until minOf(ids.length(), 50)).mapNotNull { index ->
            val item = ids.optJSONObject(index) ?: return@mapNotNull null
            val id = item.optString("id")
            if (POST_ID.matches(id)) GroupIdHit(id, item.optString("source").take(30)) else null
        }
        val segment = group.optString("segment").takeIf { it.isNotBlank() && Regex("^[A-Za-z0-9._-]{1,100}$").matches(it) }
        return segment to hits
    }

    fun canonicalPermalink(groupId: String, postId: String) = "https://www.facebook.com/groups/$groupId/posts/$postId/"

    fun parseScanResult(message: Any?, request: ScanRequest): ScanReport {
        val json = asJson(message) ?: return failure(ScanStatus.PROTOCOL_ERROR, "Nieprawidłowa wiadomość")
        if (json.optString("type") != "scanResult") return failure(ScanStatus.PROTOCOL_ERROR, "Nieoczekiwany typ")
        if (json.optString("nonce") != request.nonce) return failure(ScanStatus.PROTOCOL_ERROR, "Niezgodny nonce")
        val status = runCatching { ScanStatus.valueOf(json.optString("status")) }.getOrNull()
            ?.takeIf { it.ordinal <= ScanStatus.COLLECTOR_ERROR.ordinal }
            ?: return failure(ScanStatus.PROTOCOL_ERROR, "Nieznany status")
        val raw = json.optJSONArray("posts") ?: JSONArray()
        val seen = LinkedHashMap<String, FoundPost>()
        var rejected = 0
        for (index in 0 until raw.length()) {
            val item = raw.optJSONObject(index)
            val postId = item?.optString("postId").orEmpty()
            val permalink = item?.optString("permalink").orEmpty()
            val valid = POST_ID.matches(postId) && permalink == canonicalPermalink(request.groupId, postId)
            when {
                !valid || postId in seen || seen.size >= request.maxPosts.coerceAtMost(PocPolicy.MAX_POSTS) -> rejected++
                else -> seen[postId] = FoundPost(postId, permalink, item!!.optString("idSource").take(20))
            }
        }
        // A stop state never carries posts, whatever the page sent.
        val posts = if (status == ScanStatus.OK) seen.values.toList() else emptyList()
        if (status != ScanStatus.OK) rejected += seen.size
        val finalStatus = if (status == ScanStatus.OK && posts.isEmpty()) ScanStatus.NO_POSTS else status
        return ScanReport(
            status = finalStatus,
            posts = posts,
            rejectedByApp = rejected,
            diagnostics = intMap(json.optJSONObject("diagnostics")),
            scrolls = json.optInt("scrolls", 0),
            probe = parseProbe(json.optJSONObject("probe")),
            error = json.optString("error").takeIf { it.isNotBlank() }?.take(120),
        )
    }

    fun parseProbe(json: JSONObject?): PageProbe? = json?.let {
        PageProbe(
            host = it.optString("host").take(80),
            path = it.optString("path").take(200),
            title = it.optString("title").take(120),
            readyState = it.optString("readyState").take(20),
            elements = it.optInt("elements"),
            forms = it.optInt("forms"),
            inputs = it.optInt("inputs"),
            passwordInputs = it.optInt("passwordInputs"),
            articles = it.optInt("articles"),
            iframes = it.optInt("iframes"),
        )
    }

    /** Accepts what GeckoView delivers (JSONObject) or a JSON string; refuses oversized payloads. */
    fun asJson(message: Any?): JSONObject? = when (message) {
        is JSONObject -> message.takeIf { it.toString().length <= MAX_MESSAGE_CHARS }
        is String -> if (message.length > MAX_MESSAGE_CHARS) null else runCatching { JSONObject(message) }.getOrNull()
        else -> null
    }

    fun failure(status: ScanStatus, error: String? = null) = ScanReport(status, emptyList(), 0, emptyMap(), 0, null, error)

    private fun intMap(json: JSONObject?): Map<String, Int> {
        if (json == null) return emptyMap()
        return json.keys().asSequence().take(30).associateWith { json.optInt(it) }
    }
}
