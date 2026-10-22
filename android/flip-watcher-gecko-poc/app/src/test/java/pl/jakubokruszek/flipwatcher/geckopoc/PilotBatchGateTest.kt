package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import pl.jakubokruszek.flipwatcher.geckopoc.pilot.PilotBatchGate
import java.time.Instant

class PilotBatchGateTest {
    private val time=Instant.parse("2026-10-22T10:00:00Z").toEpochMilli()
    private val uuid="11111111-1111-4111-8111-111111111111"
    private val id="550000000000091"
    private fun permit()=PilotBatchGate.Permit(true,true,true,true,true,time+60_000)
    private fun claim()=JSONObject().put("id",uuid).put("runId",uuid).put("sourceScanId",uuid).put("filterId",uuid).put("leaseToken",uuid)
        .put("consumerType","ANDROID_WEBVIEW").put("jobType","SOURCE_SCAN").put("imageMode","SOURCE_SCAN_DATA_ONLY").put("leasedUntil",Instant.ofEpochMilli(time+180_000).toString())
        .put("group",JSONObject().put("id",uuid).put("type","GROUP").put("sourceId",PocPolicy.APPROVED_GROUP_ID).put("url",PocPolicy.APPROVED_GROUP_URL))
    private fun post(key:String=id)=JSONObject().put("postId",key).put("permalink","${PocPolicy.APPROVED_GROUP_URL}posts/$key/")
        .put("sourceType","GROUP").put("sourceId",PocPolicy.APPROVED_GROUP_ID).put("identityConfidence","EXACT").put("identityReasons",JSONArray().put("STRUCTURED_EXACT_STORY_ROOT"))
        .put("text","REAL_SOURCE_FIXTURE").put("author","FIXTURE_AUTHOR").put("publishedAt",Instant.ofEpochMilli(time-30_000).toString()).put("discoveryLayers",JSONArray().put("NETWORK"))
        .put("firstSeenIteration",2).put("discoverySource","MAIN_FEED").put("foundInMainFeed",true).put("firstSeenPhase","MAIN_FEED").put("media",JSONArray())
    private fun batch(rows:JSONArray=JSONArray().put(post()))=JSONObject().put("scanId",uuid).put("sourceType","GROUP").put("sourceId",PocPolicy.APPROVED_GROUP_ID)
        .put("sourceUrl",PocPolicy.APPROVED_GROUP_URL).put("imageMode","SOURCE_SCAN_DATA_ONLY").put("collectedAt",Instant.ofEpochMilli(time).toString()).put("posts",rows)
        .put("health",JSONObject().put("status","DEGRADED").put("visibleCardCount",7).put("capturedPostCount",rows.length()).put("scrolls",29).put("durationMs",30000).put("stopReason","DONE"))
    private fun rejected(job:JSONObject=claim(),raw:JSONObject=batch(),p:PilotBatchGate.Permit=permit()) {
        try {PilotBatchGate{time}.prepare(p,job,raw);fail("unsafe pilot input accepted")}catch(e:IllegalArgumentException){assertTrue(e.message!!.startsWith("PILOT_"));assertFalse(e.message!!.contains("REAL_SOURCE_FIXTURE"))}
    }
    @Test fun snapshotPreservesRealFieldsAndMeasuredCountersButStripsUnrelatedSecrets(){
        val raw=batch();raw.getJSONArray("posts").getJSONObject(0).put("cookie","SECRET");raw.put("token","SECRET")
        val value=PilotBatchGate{time}.prepare(permit(),claim(),raw);assertEquals(1,value.posts);assertFalse(value.toString().contains(id));assertFalse(value.toString().contains("REAL_SOURCE_FIXTURE"))
        System.getProperty("pilot.fixture.output")?.let{path->java.io.File(path).apply{parentFile.mkdirs();writeText(value.forCompletion().toString())}}
        val body=value.forCompletion();assertFalse(body.toString().contains("SECRET"));assertEquals(7,body.getJSONObject("health").getInt("visibleCardCount"));assertEquals(29,body.getJSONObject("health").getInt("scrolls"));assertEquals(30000,body.getJSONObject("health").getInt("durationMs"))
        body.put("sourceId","other");raw.getJSONArray("posts").getJSONObject(0).put("text","MUTATED");assertEquals(PocPolicy.APPROVED_GROUP_ID,value.forCompletion().getString("sourceId"));assertFalse(value.forCompletion().toString().contains("MUTATED"))
    }
    @Test fun newConsentEnvironmentScreenAndForegroundAreRequiredBeforeReadingPayload(){
        for(p in listOf(PilotBatchGate.Permit(),PilotBatchGate.Permit(false,true,true,true,true,time+1000),PilotBatchGate.Permit(true,false,true,true,true,time+1000),PilotBatchGate.Permit(true,true,false,true,true,time+1000),PilotBatchGate.Permit(true,true,true,false,true,time+1000),PilotBatchGate.Permit(true,true,true,true,false,time+1000)))rejected(JSONObject(),JSONObject(),p)
    }
    @Test fun expiredAndReusedPermitsCannotBeRenewedByAnotherGate(){
        rejected(p=PilotBatchGate.Permit(true,true,true,true,true,time));val p=permit();PilotBatchGate{time}.prepare(p,claim(),batch());rejected(p=p)
        val bad=permit();rejected(raw=JSONObject(),p=bad);rejected(p=bad)
    }
    @Test fun onlyExactApprovedSourceScopedValidLeaseIsAccepted(){
        for(key in listOf("consumerType","jobType","imageMode","leaseToken"))rejected(job=claim().put(key,"INVALID"))
        rejected(job=claim().put("leasedUntil",Instant.ofEpochMilli(time-1).toString()))
        for((key,value) in listOf("type" to "PROFILE","sourceId" to uuid,"url" to PocPolicy.APPROVED_GROUP_URL+"?x=1")){val j=claim();j.getJSONObject("group").put(key,value);rejected(job=j)}
        rejected(raw=batch().put("scanId","22222222-2222-4222-8222-222222222222"));rejected(raw=batch().put("sourceId",uuid))
    }
    @Test fun selectedPreviewRowsUnknownDatesAndInventedExactLabelsAreNotSourceRecords(){
        rejected(raw=batch(JSONArray().put(JSONObject().put("postId",id).put("price",319000).put("photos",3))))
        for((key,value) in listOf("publishedAt" to JSONObject.NULL,"text" to JSONObject.NULL,"author" to " ","text" to " ","identityConfidence" to "UNVERIFIED","identityReasons" to JSONArray(),"permalink" to "https://www.facebook.com/photo.php?fbid=$id"))rejected(raw=batch(JSONArray().put(post().put(key,value))))
        for(offset in listOf(-73*60*60*1000L,60_000L))rejected(raw=batch(JSONArray().put(post().put("publishedAt",Instant.ofEpochMilli(time+offset).toString()))))
    }
    @Test fun twentyPostsCapDuplicatesAndSourceProvenanceAreChecked(){
        val many=JSONArray();repeat(21){many.put(post((550000000000000L+it).toString()))};rejected(raw=batch(many));rejected(raw=batch(JSONArray().put(post()).put(post())))
        rejected(raw=batch(JSONArray().put(post().put("sourceId","other"))));rejected(raw=batch(JSONArray().put(post().put("firstSeenPhase","SEARCH"))));rejected(raw=batch(JSONArray().put(post().put("firstSeenIteration",-1))))
    }
    @Test fun mediaNeedsExactParentAndSafeOriginWithoutCredentialParameters(){
        val image=JSONObject().put("url","https://scontent.fbcdn.net/image.jpg").put("mediaId","880000000000001").put("exactPostId",id).put("exactAssociation",true)
        val valid=batch(JSONArray().put(post().put("media",JSONArray().put(image))));assertEquals(1,PilotBatchGate{time}.prepare(permit(),claim(),valid).forCompletion().getJSONArray("posts").getJSONObject(0).getJSONArray("media").length())
        for((key,value) in listOf("exactPostId" to "550000000000092","exactAssociation" to false,"url" to "https://fbcdn.net.evil.test/a.jpg","url" to "https://scontent.fbcdn.net/a.jpg?access_token=SECRET","url" to "https://scontent.fbcdn.net/a.jpg?access%5Ftoken=SECRET")){val copy=JSONObject(image.toString()).put(key,value);rejected(raw=batch(JSONArray().put(post().put("media",JSONArray().put(copy)))))}
    }
    @Test fun sourceHealthCannotInventCaptureOrOverflowBounds(){
        for((key,value) in listOf("capturedPostCount" to 2,"scrolls" to 31,"durationMs" to 60001,"visibleCardCount" to -1,"stopReason" to "PRIVATE text")){val b=batch();b.getJSONObject("health").put(key,value);rejected(raw=b)}
    }
    @Test fun parallelGateInstancesCannotReuseTheSamePermit(){
        val p=permit();val start=java.util.concurrent.CountDownLatch(1);val done=java.util.concurrent.CountDownLatch(2);val wins=java.util.concurrent.atomic.AtomicInteger()
        repeat(2){Thread{start.await();try{PilotBatchGate{time}.prepare(p,claim(),batch());wins.incrementAndGet()}catch(_:IllegalArgumentException){}finally{done.countDown()}}.start()}
        start.countDown();assertTrue(done.await(5,java.util.concurrent.TimeUnit.SECONDS));assertEquals(1,wins.get())
    }
}
