package pl.jakubokruszek.flipcollector.collector

import java.net.URI
import java.util.UUID
import org.json.JSONObject

/** One approved source, no profiles, no gallery/detail navigation. */
data class LivePilotSource(val remoteId: String, val sourceId: String, val url: String) {
    init {
        require(UUID.fromString(remoteId).toString() == remoteId)
        require(Regex("^[A-Za-z0-9._-]{1,100}$").matches(sourceId))
        require(WebViewPolicy.navigation(url) == WebViewPolicy.Decision.ALLOW)
        val uri = URI(url)
        require(uri.rawPath == "/groups/$sourceId/" && uri.rawQuery == null && uri.rawFragment == null)
    }
    val origin: String get() = "https://${URI(url).host}"
    /** A first-party Facebook login in the SAME WebView; no pop-ups, injected clicks or credential interception. */
    fun manualLoginUrl(): String = "https://www.facebook.com/login/?next=" +
        java.net.URLEncoder.encode(url, "UTF-8")
    fun matchesPage(value: String): Boolean = runCatching {
        val uri = URI(value)
        WebViewPolicy.navigation(value) == WebViewPolicy.Decision.ALLOW &&
            "https://${uri.host}" == origin && uri.rawPath.trimEnd('/') == "/groups/$sourceId" && uri.rawQuery == null && uri.rawFragment == null
    }.getOrDefault(false)
    fun input(): JSONObject = JSONObject().put("sourceId", sourceId).put("sourceType", "GROUP").put("sourceUrl", url)
    fun checkJob(job: ClaimedJob) {
        val group = requireNotNull(job.group)
        require(job.jobType == "SOURCE_SCAN" && group.getString("id") == remoteId &&
            group.getString("type") == "GROUP" && group.getString("sourceId") == sourceId && group.getString("url") == url) { "PILOT_SOURCE_JOB_MISMATCH" }
    }
}

object LivePilotPolicy {
    const val MAX_POSTS = 20
    const val TIMEOUT_MS = 45_000L
    const val MAX_PAYLOAD_BYTES = 512 * 1024
    // Exact extension artifact; updating the core requires an explicit review of this pin.
    const val CORE_SHA256 = "32c98525cfac6b580b93b4847140d4872ee4119b26981786322235df42e5b88b"
    fun allowResource(url: String): Boolean = runCatching {
        val uri = URI(url)
        val host = uri.host.orEmpty().lowercase()
        WebViewPolicy.resource(url) == WebViewPolicy.Decision.ALLOW && uri.userInfo == null && uri.port in setOf(-1, 443) &&
            (!host.endsWith(".fbcdn.net") || host.startsWith("static."))
    }.getOrDefault(false)
    fun trustedMessage(origin: String, mainFrame: Boolean, page: String, source: LivePilotSource): Boolean = runCatching {
        val uri = URI(origin)
        mainFrame && uri.scheme == "https" && uri.host == URI(source.origin).host && uri.port in setOf(-1,443) &&
            uri.userInfo == null && uri.rawPath.orEmpty() in setOf("", "/") && uri.rawQuery == null && uri.rawFragment == null && source.matchesPage(page)
    }.getOrDefault(false)

    fun validate(raw: String, nonce: String, source: LivePilotSource): JSONObject {
        require(raw.toByteArray(Charsets.UTF_8).size <= MAX_PAYLOAD_BYTES) { "PILOT_PAYLOAD_TOO_LARGE" }
        val envelope = JSONObject(raw)
        require(envelope.getInt("version") == 1 && envelope.getString("nonce") == nonce) { "PILOT_CHANNEL_INVALID" }
        if (envelope.has("stop")) {
            val stop = envelope.getString("stop")
            require(stop in setOf("LOGIN_REQUIRED", "CHECKPOINT", "CAPTCHA", "GROUP_UNAVAILABLE", "NO_VERIFIED_POSTS", "COLLECTOR_ERROR"))
            throw IllegalStateException(stop)
        }
        val batch = envelope.getJSONObject("batch")
        require(batch.getString("sourceId") == source.sourceId && batch.getString("sourceType") == "GROUP" && batch.getString("sourceUrl") == source.url)
        require(batch.getString("imageMode") == "SOURCE_SCAN_DATA_ONLY")
        val posts = batch.getJSONArray("posts")
        require(posts.length() in 1..MAX_POSTS)
        val ids = mutableSetOf<String>()
        var exact = 0
        for (index in 0 until posts.length()) {
            val post = posts.getJSONObject(index)
            val id = post.getString("postId")
            require(Regex("^[0-9]{1,40}$").matches(id) && ids.add(id)) { "PILOT_POST_ID_INVALID" }
            require(post.getString("sourceId") == source.sourceId && post.getString("sourceType") == "GROUP")
            require(post.getString("permalink") == "${source.origin}/groups/${source.sourceId}/posts/$id/" ||
                post.getString("permalink") == "https://www.facebook.com/groups/${source.sourceId}/posts/$id/") { "PILOT_PERMALINK_INVALID" }
            val confidence = post.getString("identityConfidence")
            require(confidence in setOf("EXACT", "UNVERIFIED"))
            val media = post.getJSONArray("media")
            require(media.length() <= 20)
            if (confidence == "UNVERIFIED") require(media.length() == 0)
            else {
                exact++
                require(!post.isNull("author") && !post.isNull("text") && post.optString("author").isNotBlank() && post.optString("text").isNotBlank())
                require(post.getString("author").length <= 1000 && post.getString("text").length <= 20_000)
            }
            for (j in 0 until media.length()) {
                val item = media.getJSONObject(j)
                val uri = URI(item.getString("url"))
                require(item.getBoolean("exactAssociation") && item.getString("exactPostId") == id)
                require(uri.scheme == "https" && uri.userInfo == null && uri.port == -1 && uri.host?.endsWith(".fbcdn.net") == true)
            }
        }
        check(exact > 0) { "NO_VERIFIED_POSTS" }
        val health = batch.getJSONObject("health")
        require(health.getInt("capturedPostCount") == posts.length() && health.getInt("visibleCardCount") >= 0)
        require(health.getInt("scrolls") in 0..3 && health.getLong("durationMs") in 0..TIMEOUT_MS)
        return batch
    }
}
