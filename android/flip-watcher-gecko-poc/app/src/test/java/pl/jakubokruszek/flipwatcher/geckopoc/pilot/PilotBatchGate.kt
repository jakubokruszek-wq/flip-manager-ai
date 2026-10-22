package pl.jakubokruszek.flipwatcher.geckopoc.pilot

import org.json.JSONArray
import org.json.JSONObject
import pl.jakubokruszek.flipwatcher.geckopoc.PocPolicy
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/** Preparatory boundary only. Test sources compile it; the local APK has no upload route. */
class PilotBatchGate(private val now:()->Long=System::currentTimeMillis) {
    class Permit(val nonProductionVerified:Boolean=false,val screenOn:Boolean=false,val foreground:Boolean=false,
        val sourceTextTransferConsent:Boolean=false,val mediaMetadataTransferConsent:Boolean=false,
        val expiresAt:Long=0L) {
        internal val used=AtomicBoolean(false)
        override fun toString()="PilotPermit(redacted)"
    }
    class Snapshot internal constructor(private val body:String,val posts:Int) {
        /** Feed these exact data to the EXISTING SignedCollectorClient.prepareCompletion + durable outbox. */
        fun forCompletion():JSONObject=JSONObject(body)
        override fun toString()="PilotSnapshot(redacted)"
    }
    @Synchronized fun prepare(permit:Permit,claim:JSONObject,batch:JSONObject):Snapshot {
        require(permit.used.compareAndSet(false,true)) { "PILOT_PERMIT_USED" } // Invalid input consumes consent too.
        require(permit.nonProductionVerified&&permit.screenOn&&permit.foreground&&permit.sourceTextTransferConsent&&permit.mediaMetadataTransferConsent) { "PILOT_CONSENT_OR_CONTEXT" }
        val time=now();require(permit.expiresAt>time&&permit.expiresAt-time<=60_000) { "PILOT_PERMIT_EXPIRED" }
        return try { snapshot(claim,batch,time) } catch (_:Exception) { throw IllegalArgumentException("PILOT_PAYLOAD_REJECTED") }
    }
    private fun snapshot(job:JSONObject,input:JSONObject,time:Long):Snapshot {
        fun uuid(v:String)=UUID.fromString(v).toString()==v
        require(job.getString("consumerType")=="ANDROID_WEBVIEW"&&job.getString("jobType")=="SOURCE_SCAN"&&job.getString("imageMode")=="SOURCE_SCAN_DATA_ONLY")
        require(listOf("id","runId","sourceScanId","filterId","leaseToken").all{uuid(job.getString(it))})
        require(Instant.parse(job.getString("leasedUntil")).toEpochMilli()>time)
        val group=job.getJSONObject("group");require(uuid(group.getString("id")))
        require(group.getString("type")=="GROUP"&&group.getString("sourceId")==PocPolicy.APPROVED_GROUP_ID&&group.getString("url")==PocPolicy.APPROVED_GROUP_URL)
        require(input.getString("sourceId")==group.getString("sourceId")&&input.getString("sourceType")=="GROUP"&&input.getString("sourceUrl")==PocPolicy.APPROVED_GROUP_URL)
        require(input.getString("scanId")==job.getString("runId")&&input.getString("imageMode")=="SOURCE_SCAN_DATA_ONLY")
        val collected=Instant.parse(input.getString("collectedAt")).toEpochMilli();require(collected in (time-60_000)..(time+5_000))
        val rows=input.getJSONArray("posts");require(rows.length() in 1..20)
        val seen=HashSet<String>();val posts=JSONArray()
        for(i in 0 until rows.length()){
            val raw=rows.getJSONObject(i);val id=raw.getString("postId")
            require(Regex("^[0-9]{5,30}$").matches(id)&&seen.add(id))
            require(raw.getString("permalink")=="${PocPolicy.APPROVED_GROUP_URL}posts/$id/"&&raw.getString("sourceId")==PocPolicy.APPROVED_GROUP_ID&&raw.getString("sourceType")=="GROUP")
            require(raw.getString("identityConfidence")=="EXACT")
            val reasons=raw.getJSONArray("identityReasons");require((0 until reasons.length()).any{reasons.getString(it)=="STRUCTURED_EXACT_STORY_ROOT"})
            val text=raw.getString("text");val author=raw.getString("author");require(text.length in 1..20_000&&text.isNotBlank()&&author.length in 1..200&&author.isNotBlank())
            val published=Instant.parse(raw.getString("publishedAt")).toEpochMilli();require(published in (time-72*60*60*1000L)..(time+5_000))
            val layers=raw.getJSONArray("discoveryLayers");require(layers.length() in 1..3&&(0 until layers.length()).all{layers.getString(it) in setOf("DOM","HYDRATION","NETWORK")})
            require(raw.opt("firstSeenIteration") is Int&&raw.getInt("firstSeenIteration") in 0..10000)
            require(raw.getString("discoverySource")=="MAIN_FEED"&&raw.opt("foundInMainFeed")==true&&raw.getString("firstSeenPhase")=="MAIN_FEED")
            val media=JSONArray();val images=raw.getJSONArray("media");require(images.length()<=20)
            for(m in 0 until images.length()){
                val image=images.getJSONObject(m);require(image.opt("exactAssociation")==true&&image.getString("exactPostId")==id)
                require(image.getString("url").length<=2048);val url=java.net.URI(image.getString("url"));require(url.scheme=="https"&&url.rawUserInfo==null&&url.port==-1&&url.rawFragment==null&&url.host!=null&&listOf("facebook.com","fbcdn.net").any{url.host==it||url.host.endsWith(".$it")})
                require(!Regex("(?:^|&)(?:access_token|token|authorization|cookie)=",RegexOption.IGNORE_CASE).containsMatchIn(url.rawQuery.orEmpty()))
                val mediaId=if(image.isNull("mediaId"))JSONObject.NULL else image.getString("mediaId").also{require(Regex("^[0-9]{5,30}$").matches(it))}
                media.put(JSONObject().put("url",url.toString()).put("mediaId",mediaId).put("exactPostId",id).put("exactAssociation",true).put("discoveryLayers",JSONArray(layers.toString())))
            }
            posts.put(JSONObject().put("postId",id).put("permalink",raw.getString("permalink")).put("sourceId",PocPolicy.APPROVED_GROUP_ID).put("sourceType","GROUP")
                .put("author",author).put("text",text).put("publishedAt",raw.getString("publishedAt")).put("timestampText",JSONObject.NULL).put("identityConfidence","EXACT")
                .put("identityReasons",JSONArray().put("STRUCTURED_EXACT_STORY_ROOT")).put("discoveryLayers",JSONArray(layers.toString())).put("firstSeenIteration",raw.getInt("firstSeenIteration"))
                .put("media",media).put("discoverySource","MAIN_FEED").put("foundInMainFeed",true).put("firstSeenPhase","MAIN_FEED"))
        }
        // Preserve measured counters. Never invent visibility or duration from post count.
        val measured=input.getJSONObject("health")
        fun count(name:String,max:Int):Int {val value=measured.get(name);require(value is Int&&value in 0..max);return value}
        require(measured.getString("status") in setOf("HEALTHY","DEGRADED"))
        require(count("capturedPostCount",20)==posts.length())
        val stop=measured.getString("stopReason");require(Regex("^[A-Z0-9_]{1,100}$").matches(stop))
        val health=JSONObject().put("status","DEGRADED").put("visibleCardCount",count("visibleCardCount",10000)).put("capturedPostCount",posts.length())
            .put("scrolls",count("scrolls",30)).put("durationMs",count("durationMs",60000)).put("stopReason",stop).put("reasons",JSONArray().put("COMPLETENESS_UNVERIFIED"))
        val result=JSONObject().put("scanId",job.getString("runId")).put("sourceId",PocPolicy.APPROVED_GROUP_ID).put("sourceType","GROUP").put("sourceUrl",PocPolicy.APPROVED_GROUP_URL)
            .put("collectedAt",input.getString("collectedAt")).put("imageMode","SOURCE_SCAN_DATA_ONLY").put("health",health).put("posts",posts)
        val raw=result.toString();require(raw.toByteArray(Charsets.UTF_8).size<=1_900_000)
        return Snapshot(raw,posts.length())
    }
}
