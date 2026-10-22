package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DesktopPreviewTest {
    private val group=PocPolicy.APPROVED_GROUP_ID
    private val target="https://www.facebook.com/groups/$group/"
    private val nonce="12345678-1234-1234-1234-123456789012"
    private fun row(id:String="550000000000001")=JSONObject().put("postId",id).put("permalink","https://www.facebook.com/groups/$group/posts/$id/").put("layer","MIXED")
        .put("price",319000).put("priceSource","EXPLICIT_TOTAL").put("area",42.42).put("rooms",2).put("district","Polesie").put("neighborhood","Retkinia").put("street",JSONObject.NULL)
        .put("intent","SELL_PROPERTY").put("usable",true).put("photos",1).put("qualification","CANDIDATE")
    private fun message(rows:JSONArray=JSONArray().put(row())):JSONObject {
        val stats=JSONObject(DesktopProtocol.emptyStats()).put("candidates",rows.length()).put("verified",1).put("desktop",1)
        return JSONObject().put("type","desktopPreviewResult").put("nonce",nonce).put("status","OK").put("reason","DONE").put("rows",rows).put("stats",stats)
    }
    @Test fun freshConsentAndOneObjectPerAttempt(){val g=DesktopTrial(target,{0L});assertFalse(g.begin(false));assertFalse(g.begin(true));assertFalse(g.active)}
    @Test fun gateAllowsOnlyOneNativeLoadAndBoundedSameGroupHttpRedirects(){
        val g=DesktopTrial(target,{0L});assertTrue(g.begin(true));assertTrue(g.location(target));assertFalse(g.located);assertTrue(g.armed())
        assertTrue(g.request(target,false,false,false));assertTrue(g.location(target));assertTrue(g.located)
        val canonical=target.replace("www.facebook.com","m.facebook.com");assertTrue(g.request(canonical,true,false,false));assertTrue(g.location(canonical))
        assertFalse(g.request(target,false,false,false));assertEquals("NAVIGATION",g.reason)
    }
    @Test fun unsafeDestinationGestureAndNewWindowAlwaysStop(){
        for(mode in 0..4){val g=DesktopTrial(target,{0L});g.begin(true);g.armed();assertFalse(g.request(if(mode==0)target.replace(group,"other") else if(mode==1)target+"?private=1" else target,false,mode==2,mode==3||mode==4));assertFalse(g.active)}
    }
    @Test fun desktopDeadlineIsSharedAndCannotBeRenewedByPhase(){var clock=0L;val g=DesktopTrial(target,{clock});g.begin(true);g.armed();g.request(target,false,false,false);clock=59_999;g.waitFor(DesktopTrial.Phase.FRESHNESS);assertTrue(g.tick());clock=60_000;assertFalse(g.tick());assertEquals("DEADLINE_FRESHNESS",g.reason);assertFalse(g.location(target));assertFalse(g.complete())}
    @Test fun pausedGateRejectsLateCallbacksAndConfirmation(){val g=DesktopTrial(target,{0L});g.begin(true);g.armed();g.stop("PAUSED");assertFalse(g.request(target,false,false,false));assertFalse(g.location(target));assertFalse(g.complete());assertEquals("PAUSED",g.reason)}
    @Test fun completionRequiresRealRequestLocationAndReadingPhase(){val g=DesktopTrial(target,{0L});g.begin(true);g.armed();assertFalse(g.complete());g.request(target,false,false,false);g.location(target);assertFalse(g.complete());g.waitFor(DesktopTrial.Phase.READING);assertTrue(g.complete());assertEquals("DONE",g.reason)}
    @Test fun exactFieldsSurviveOnlyValidBoundedPrivateProtocol(){val p=DesktopProtocol.parse(message(),nonce)!!;assertEquals(1,p.rows.size);assertEquals(319000.0,p.rows[0].price!!,0.01);assertEquals(42.42,p.rows[0].area!!,0.01);assertEquals(2,p.rows[0].rooms);assertEquals("Retkinia",p.rows[0].neighborhood)}
    @Test fun foreignPhotoFakeAndDuplicateIdentitiesAreRejected(){
        for(r in listOf(row().put("permalink",row().getString("permalink").replace(group,"other")),row().put("permalink","https://www.facebook.com/photo/?fbid=550000000000001"),row().put("postId","TOKEN"),row().put("permalink",row().getString("permalink")+"?token=private")))assertNull(DesktopProtocol.parse(message(JSONArray().put(r)),nonce))
        assertNull(DesktopProtocol.parse(message(JSONArray().put(row()).put(row())),nonce))
        val many=JSONArray();repeat(21){many.put(row((550000000000001L+it).toString()))};assertNull(DesktopProtocol.parse(message(many),nonce))
    }
    @Test fun rawContentAndBadSchemasNeverEnterApp(){for(key in listOf("text","author","cookie","token","imageUrl"))assertNull(DesktopProtocol.parse(message(JSONArray().put(row().put(key,"PRIVATE"))),nonce));assertNull(DesktopProtocol.parse(message().put("raw","PRIVATE"),nonce));assertNull(DesktopProtocol.parse(message(),"wrong"));assertNull(DesktopProtocol.parse(message().put("stats",JSONObject().put("post_id",550000000000001)),nonce))}
    @Test fun invalidFieldTypesRangesAndConflictSourcesFailClosed(){for((key,value) in listOf("price" to -1,"area" to "42","rooms" to 2.5,"photos" to 21,"district" to "PRIVATE","intent" to "PRIVATE","priceSource" to "NONE","qualification" to "PRIVATE"))assertNull(DesktopProtocol.parse(message(JSONArray().put(row().put(key,value))),nonce))}
    @Test fun summaryPersistsOnlyFixedAggregateAndCannotRestorePostData(){val reply=DesktopProtocol.parse(message(),nonce)!!;val s=DesktopSummary.create("DONE",1,reply);assertEquals("CONDITIONAL_GO",s.verdict);assertEquals(1,s.offers);assertFalse(s.encode().contains("550000000000001"));assertFalse(s.encode().contains("319000"));assertFalse(s.encode().contains("Retkinia"));assertFalse(s.report().contains("/groups/"));assertEquals(s.report(),DesktopSummary.decode(s.encode())!!.report())}
    @Test fun unsafeAndNonSaleRowsCannotProduceGo(){val reply=DesktopProtocol.parse(message(),nonce)!!;assertEquals("NO_GO",DesktopSummary.create("CONTEXT",1,reply).verdict);val wanted=reply.copy(rows=reply.rows.map{it.copy(intent="BUY_PROPERTY",price=null)});assertEquals("NO_GO",DesktopSummary.create("DONE",1,wanted).verdict);assertEquals("NO_GO",DesktopSummary.create("DONE",1,reply.copy(rows=emptyList())).verdict)}
    @Test fun persistedSummaryRejectsExtraFieldsUnknownReasonsAndRawMapKeys(){val s=DesktopSummary.create("DONE",1,DesktopProtocol.parse(message(),nonce)!!);assertNull(DesktopSummary.decode(JSONObject(s.encode()).put("postId","PRIVATE").toString()));assertNull(DesktopSummary.decode(JSONObject(s.encode()).put("reason","PRIVATE").toString()));assertNull(DesktopSummary.decode(JSONObject(s.encode()).put("stats",JSONObject().put("PRIVATE",1)).toString()));assertEquals("PROTOCOL",DesktopSummary.create("DONE",1,DesktopReply("OK","DONE",emptyList(),mapOf("PRIVATE" to 1))).reason)}
    @Test fun thirtyStepsAreAcceptedButOverLimitAndInventedMovesAreRejected(){
        val valid=message();valid.getJSONObject("stats").put("scrollSteps",30).put("scrollMoves",29)
        assertNotNull(DesktopProtocol.parse(valid,nonce))
        for((steps,moves) in listOf(31 to 30,30 to 31)){
            val bad=message();bad.getJSONObject("stats").put("scrollSteps",steps).put("scrollMoves",moves)
            assertNull(DesktopProtocol.parse(bad,nonce))
        }
    }
    @Test fun scrollTimingAndStallsAreBoundedAndCannotCarryUnknownFields(){
        val ok=message();ok.getJSONObject("stats").put("scrollElapsedMs",30000).put("scrollSteps",30).put("scrollMoves",3).put("scrollStalls",27).put("scrollAtEnd",2).put("scrollNoTarget",5)
        assertNotNull(DesktopProtocol.parse(ok,nonce))
        for((key,value) in listOf("scrollElapsedMs" to 30001,"scrollStalls" to 28,"scrollAtEnd" to 513,"scrollNoTarget" to 31)){
            val bad=JSONObject(ok.toString());bad.getJSONObject("stats").put(key,value);assertNull(DesktopProtocol.parse(bad,nonce))
        }
    }
    @Test fun priorThirtyStatHistoryIsReadableWithoutMutatingStoredHistory(){
        val old=JSONObject(DesktopSummary.create("DONE",1,DesktopProtocol.parse(message(),nonce)!!).encode())
        for(key in DesktopProtocol.statKeys.drop(30))old.getJSONObject("stats").remove(key)
        val raw=old.toString();val restored=DesktopSummary.decode(raw)!!
        assertEquals(0,restored.stats.getValue("scrollElapsedMs"));assertEquals(raw,old.toString())
    }
}
