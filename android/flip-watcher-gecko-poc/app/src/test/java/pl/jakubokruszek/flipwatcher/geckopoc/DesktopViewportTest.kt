package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DesktopViewportTest {
    private val nonce="11111111-1111-4111-8111-111111111111"
    private val id="22222222-2222-4222-8222-222222222222"
    private fun base(action:String)=JSONObject().put("type","desktopViewportRequest").put("nonce",nonce).put("requestId",id).put("action",action)
    private fun scroll()=base("scroll").put("x",0.5).put("y",0.6)
    private fun photos()=base("photos").put("width",980).put("height",800).put("tiles",org.json.JSONArray().put(JSONObject().put("postId","550000000000091").put("slot",0).put("x",0).put("y",10).put("width",300).put("height",160)))
    @Test fun acceptsOnlyBoundedNativeActionMetadata(){assertEquals("scroll",DesktopViewportProtocol.parse(scroll(),nonce)!!.action);assertEquals(1,DesktopViewportProtocol.parse(photos(),nonce)!!.tiles.size)}
    @Test fun rejectsWrongConsentNonceIdentityAndUnknownPayload(){
        assertNull(DesktopViewportProtocol.parse(scroll(),"wrong"));assertNull(DesktopViewportProtocol.parse(scroll().put("requestId","fake"),nonce))
        assertNull(DesktopViewportProtocol.parse(scroll().put("x",-1),nonce));assertNull(DesktopViewportProtocol.parse(scroll().put("url","https://facebook.com/"),nonce))
        assertNull(DesktopViewportProtocol.parse(scroll().put("action","click"),nonce))
    }
    @Test fun photoRectsCannotReadOutsideVisibleViewportOrSendMediaUrls(){
        for(key in listOf("url","cookie","text","token")){val p=photos();p.getJSONArray("tiles").getJSONObject(0).put(key,"SECRET");assertNull(DesktopViewportProtocol.parse(p,nonce))}
        val off=photos();off.getJSONArray("tiles").getJSONObject(0).put("x",900);assertNull(DesktopViewportProtocol.parse(off,nonce))
        val fake=photos();fake.getJSONArray("tiles").getJSONObject(0).put("postId","pfbid-fake");assertNull(DesktopViewportProtocol.parse(fake,nonce))
    }
    @Test fun photoSlotsAreBoundedDistinctAndCropCommitRequiresAnOpaqueFrameId(){
        val slot=photos();slot.getJSONArray("tiles").getJSONObject(0).put("slot",3);assertNull(DesktopViewportProtocol.parse(slot,nonce))
        val dupe=photos();dupe.getJSONArray("tiles").put(dupe.getJSONArray("tiles").getJSONObject(0));assertNull(DesktopViewportProtocol.parse(dupe,nonce))
        assertNotNull(DesktopViewportProtocol.parse(base("commit").put("frameId",id),nonce));assertNull(DesktopViewportProtocol.parse(base("commit").put("frameId","url"),nonce))
    }
    @Test fun oldCountOnlyHistoryRemainsReadableWithNewCounters(){
        val stats=DesktopProtocol.emptyStats().filterKeys{it in DesktopProtocol.statKeys.take(38)}.toMutableMap().apply{put("candidates",1);put("verified",1);put("desktop",1)}
        val raw=JSONObject().put("verdict","CONDITIONAL_GO").put("reason","DONE").put("offers",1).put("navigations",1).put("stats",JSONObject(stats)).toString()
        val result=DesktopSummary.decode(raw)!!;assertEquals(1,result.offers);assertEquals(0,result.stats.getValue("photoPreviews"));assertEquals(0,result.stats.getValue("scrollNativeMoves"))
    }
    @Test fun nativeProgressCountsCannotExceedTotalMeasuredScrolls(){
        val stats=DesktopProtocol.emptyStats().toMutableMap().apply{put("scrollNativeSteps",1);put("scrollNativeMoves",1)}
        assertNull(DesktopProtocol.parseStats(JSONObject(stats)))
        stats["scrollSteps"]=1;stats["scrollMoves"]=1;assertNotNull(DesktopProtocol.parseStats(JSONObject(stats)))
        stats["photoPreviews"]=61;assertNull(DesktopProtocol.parseStats(JSONObject(stats)))
    }
    @Test fun probeHasOnlyFreshMetadataAndNewTelemetryRemainsBounded(){
        assertEquals("probe",DesktopViewportProtocol.parse(base("probe"),nonce)!!.action)
        assertNull(DesktopViewportProtocol.parse(base("probe").put("url","SECRET"),nonce))
        val stats=DesktopProtocol.emptyStats().toMutableMap().apply{put("viewportProbeCode",3);put("viewportGranted",1)}
        assertNotNull(DesktopProtocol.parseStats(JSONObject(stats)));stats["viewportReady"]=2;assertNull(DesktopProtocol.parseStats(JSONObject(stats)))
    }
    @Test fun fortyFiveCounterHistoryIsPreservedWithoutInventingProbeSuccess(){
        val stats=DesktopProtocol.emptyStats().filterKeys{it in DesktopProtocol.statKeys.take(45)}
        val raw=JSONObject().put("verdict","NO_GO").put("reason","EMPTY").put("offers",0).put("navigations",1).put("stats",JSONObject(stats)).toString()
        val result=DesktopSummary.decode(raw)!!;assertEquals(0,result.stats.getValue("viewportReady"));assertEquals(0,result.stats.getValue("nativeRequests"))
    }
    @Test fun pointAuditIsBoundedAndDoesNotAcceptRawDomOrNonNumericFields(){
        val stats=DesktopProtocol.emptyStats().toMutableMap().apply{put("pointProbes",64);put("pointFrame",64);put("pointCache",1);put("pointCacheCards",100);put("pointRects",4)}
        assertNotNull(DesktopProtocol.parseStats(JSONObject(stats)))
        for((key,value) in listOf("pointProbes" to 65,"pointFrame" to 65,"pointCache" to 2,"pointCacheCards" to 101,"pointRects" to 5)){val bad=stats.toMutableMap();bad[key]=value;assertNull(DesktopProtocol.parseStats(JSONObject(bad)))}
        assertNull(DesktopProtocol.parseStats(JSONObject(stats).put("pointReason","PRIVATE_DOM")))
    }
    @Test fun fiftyFourCounterHistoryIsReadWithoutPretendingThatHitTestingWasMeasured(){
        val stats=DesktopProtocol.emptyStats().filterKeys{it in DesktopProtocol.statKeys.take(54)}
        val raw=JSONObject().put("verdict","NO_GO").put("reason","EMPTY").put("offers",0).put("navigations",1).put("stats",JSONObject(stats)).toString()
        val result=DesktopSummary.decode(raw)!!;assertEquals(0,result.stats.getValue("pointProbes"));assertEquals(0,result.stats.getValue("pointFrame"))
    }
    @Test fun gestureCountersAreBoundedAndOldSeventyThreeFieldHistorySurvives(){
        val stats=DesktopProtocol.emptyStats().toMutableMap().apply{put("gestureRequested",1);put("gestureTouches",1);put("gestureAnchored",1);put("gestureWaitMs",15000)}
        assertNotNull(DesktopProtocol.parseStats(JSONObject(stats)))
        for((key,value) in listOf("gestureRequested" to 2,"gestureTouches" to 21,"gestureRejected" to 21,"gestureWaitMs" to 15001,"gestureScrollSteps" to 1)){assertNull(key,DesktopProtocol.parseStats(JSONObject(stats).put(key,value)))}
        val raw=JSONObject().put("verdict","NO_GO").put("reason","EMPTY").put("offers",0).put("navigations",1).put("stats",JSONObject(DesktopProtocol.emptyStats().filterKeys{it in DesktopProtocol.statKeys.take(73)})).toString()
        assertEquals(0,DesktopSummary.decode(raw)!!.stats.getValue("gestureRequested"))
        assertNull(DesktopProtocol.parseStats(JSONObject(stats).put("gestureTarget","PRIVATE")))
    }
    @Test fun gesturePhaseHintsRequireExactNonceAndOnlyFixedStage(){
        val hint=JSONObject().put("type","desktopGestureHint").put("nonce",nonce).put("stage","WAITING")
        assertEquals("NOTICE",DesktopProtocol.gestureHint(JSONObject(hint.toString()).put("stage","NOTICE"),nonce));assertEquals("WAITING",DesktopProtocol.gestureHint(hint,nonce));assertNull(DesktopProtocol.gestureHint(hint,"stale"))
        assertNull(DesktopProtocol.gestureHint(JSONObject(hint.toString()).put("stage","SCRIPT"),nonce))
        assertNull(DesktopProtocol.gestureHint(JSONObject(hint.toString()).put("target","PRIVATE"),nonce))
    }
}
