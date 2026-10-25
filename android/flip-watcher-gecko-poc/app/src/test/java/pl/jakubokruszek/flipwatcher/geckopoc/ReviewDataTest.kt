package pl.jakubokruszek.flipwatcher.geckopoc
import org.junit.Assert.*
import org.junit.Test
class ReviewDataTest{
 private val id="550000000000091"
 private val url="https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/$id/"
 private fun row(key:String=id)=DesktopRow(key,url.replace(id,key),"DOM",null,"NONE",null,null,null,null,null,"UNKNOWN",false,0,"NO_TEXT")
 @Test fun exactTargetsRefuseCredentialsAliasesQueriesAndForeignPosts(){
  assertTrue(ReviewDataGate.matches(url,PocPolicy.APPROVED_GROUP_ID,id))
  for(raw in listOf(url.replace("https:","http:"),url+"?a=1",url+"#x",url.replace(PocPolicy.APPROVED_GROUP_ID,"foreign"),url.replace(id,"550000000000092"),url.replace("www.facebook.com","user@www.facebook.com")))assertFalse(raw,ReviewDataGate.matches(raw,PocPolicy.APPROVED_GROUP_ID,id))
 }
 @Test fun navigationHasOneCurrentOwnerAndRequiresAnAcceptedRequest(){
  val g=ReviewDataGate(PocPolicy.APPROVED_GROUP_ID){0};g.expect(id);assertFalse(g.location(url));assertFalse(g.active)
  val ok=ReviewDataGate(PocPolicy.APPROVED_GROUP_ID){0};ok.expect(id);assertTrue(ok.request(url));assertTrue(ok.location(url));ok.expect("550000000000092");assertFalse(ok.request(url));assertFalse(ok.active)
 }
 @Test fun asynchronousInitialBlankCannotBindOrReplaceAnExactDocument(){
  val g=ReviewDataGate(PocPolicy.APPROVED_GROUP_ID){0};g.expect(id);assertTrue(g.request(url))
  assertTrue(g.location("about:blank"));assertTrue(g.location(null));assertNull(g.currentUrl)
  assertTrue(g.location(url));assertEquals(url,g.currentUrl);assertFalse(g.location("about:blank"));assertFalse(g.active)
 }
 @Test fun redirectsCannotSwitchGroupPopupOrManualNavigation(){
  for(kind in listOf("group","popup","gesture")){val g=ReviewDataGate(PocPolicy.APPROVED_GROUP_ID){0};g.expect(id);assertFalse(g.request(if(kind=="group")url.replace(PocPolicy.APPROVED_GROUP_ID,"foreign")else url,newWindow=kind=="popup",userGesture=kind=="gesture"));assertFalse(g.active)}
 }
 @Test fun boundedDeadlineAndRequestsNeverRenewTheGrant(){
  var now=0L;val g=ReviewDataGate(PocPolicy.APPROVED_GROUP_ID){now};g.expect(id);repeat(4){assertTrue(g.request(url))};assertFalse(g.request(url))
  val d=ReviewDataGate(PocPolicy.APPROVED_GROUP_ID){now};d.expect(id);now=180000;assertFalse(d.tick());assertEquals("DEADLINE",d.reason)
 }
 @Test fun onlyCurrentReviewRowsAreQueuedAndCapped(){
  val candidate=row().copy(price=319000.0,priceSource="EXPLICIT_TOTAL",area=42.0,intent="SELL_PROPERTY",usable=true,qualification="CANDIDATE")
  assertTrue(ReviewDataGate.queue(listOf(candidate)).isEmpty());assertTrue(ReviewDataGate.queue(listOf(row().copy(permalink=url.replace(PocPolicy.APPROVED_GROUP_ID,"foreign")))).isEmpty())
  val rows=(0..29).map{row((550000000000100+it).toString())};assertEquals(20,ReviewDataGate.queue(rows).size);assertEquals(1,ReviewDataGate.queue(listOf(row(),row())).size)
 }
 @Test fun protocolRejectsWrongNonceUnexpectedOwnerAndMissingBoundProof(){
  val nonce="12345678-1234-1234-1234-123456789012"
  fun reply(key:String)=org.json.JSONObject().put("type","reviewPostResult").put("nonce",nonce).put("status","OK").put("reason","DONE").put("rows",org.json.JSONArray().put(ReviewDataProtocol.row(row(key)))).put("stats",org.json.JSONObject(DesktopProtocol.emptyStats()).put("verified",1).put("candidates",1)).put("bound",1).put("textRead",1)
  assertNotNull(ReviewDataProtocol.parse(reply(id),nonce,id,PocPolicy.APPROVED_GROUP_ID))
  assertNull(ReviewDataProtocol.parse(reply(id),"different",id,PocPolicy.APPROVED_GROUP_ID))
  assertNull(ReviewDataProtocol.parse(reply("550000000000092"),nonce,id,PocPolicy.APPROVED_GROUP_ID))
  assertNull(ReviewDataProtocol.parse(reply(id).put("bound",0),nonce,id,PocPolicy.APPROVED_GROUP_ID))
 }
 @Test fun stopAndExpiredGrantsNeverBecomeActiveAgain(){val g=ReviewDataGate(PocPolicy.APPROVED_GROUP_ID){0};g.expect(id);assertTrue(g.request(url));g.stop("PAUSED");g.expect(id);assertFalse(g.request(url));assertEquals("PAUSED",g.reason)}
 @Test fun onlyBoundedNumericReportsCanBeRestored(){
  val summary=ReviewDataSummary("DONE",2,2,1,1,1,0,1,0);assertEquals(summary,ReviewDataSummary.decode(summary.encode()))
  assertNull(ReviewDataSummary.decode(org.json.JSONObject(summary.encode()).put("reason",url).toString()));assertNull(ReviewDataSummary.decode(org.json.JSONObject(summary.encode()).put("opened",21).toString()));assertNull(ReviewDataSummary.decode(org.json.JSONObject(summary.encode()).put("textRead",2).toString()))
 }
 @Test fun reportsPersistCountsOnly(){val report=ReviewDataSummary("DONE",2,2,1,1,1,0,1,0);assertFalse(report.encode().contains(id));assertFalse(report.encode().contains("http"));assertTrue(report.report().contains("nie dowodzi braku"));assertEquals(0,ReviewDataSummary.fields(row()))}
 @Test fun abortReasonsAndPartialCountsSurviveWithoutBusinessData(){
  val partial=ReviewDataSummary("INTERRUPTED",13,4,3,2,1,1,1,0)
  for(reason in listOf("PAUSED","CANCELLED","ERROR","SESSION_CLOSED","unexpected")){
   val stopped=partial.stopped(reason);assertEquals(stopped,ReviewDataSummary.decode(stopped.encode()))
   assertEquals(4,stopped.opened);assertEquals(1,stopped.enriched);assertTrue(stopped.report().contains("nie oznacza"))
   assertFalse(stopped.encode().contains(id));assertFalse(stopped.encode().contains("http"))
  }
 }

}
