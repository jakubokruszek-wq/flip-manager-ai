package pl.jakubokruszek.flipwatcher.geckopoc
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class ReviewImageChecksTest{
 private val nonce="12345678-1234-1234-1234-123456789012"
 private fun reply(reason:String,count:Int=0,status:String="OK")=JSONObject().put("type","reviewImagesResult").put("nonce",nonce).put("status",status).put("count",count).put("reason",reason)
 @Test fun replyRequiresExactOutcomeCountStatusNonceAndShape(){
  assertEquals("CAPTURED",ReviewImageChecks.reply(reply("CAPTURED",1),nonce))
  assertEquals("NO_PROOF",ReviewImageChecks.reply(reply("NO_PROOF"),nonce))
  assertEquals("CONTEXT",ReviewImageChecks.reply(reply("CONTEXT",status="STOP"),nonce))
  for(j in listOf(reply("CAPTURED"),reply("NO_IMAGE",1),reply("CONTEXT"),reply("PROTOCOL"),reply("NO_ACK").put("nonce","old"),reply("NO_IMAGE").put("url","PRIVATE"),reply("NO_IMAGE").put("count","0")))assertNull(ReviewImageChecks.reply(j,nonce))
 }
 @Test fun countHistoryRequiresCompleteBoundedOutcomesAndReadsOldSummary(){
  var counts:Map<String,Int> = emptyMap();for(reason in listOf("CAPTURED","NO_PROOF","NO_IMAGE","UNLOADED","OCCLUDED","NO_ACK","AMBIGUOUS","CONTEXT","PROTOCOL"))counts=ReviewImageChecks.add(counts,reason)
  assertEquals(9,counts.getValue("checked"));assertEquals(counts,ReviewImageChecks.parse(JSONObject(counts)))
  val summary=OcrSummary("DONE",10,1,0,0,0,imageChecks=counts);assertEquals(summary,OcrSummary.decode(summary.encode()));assertTrue(summary.report().contains("sprawdzono 9"));assertFalse(summary.encode().contains("http"))
  assertNotNull(OcrSummary.decode(summary.copy(imageChecks=emptyMap()).encode()))
  for(j in listOf(JSONObject(counts).put("checked",8),JSONObject(counts).put("NO_IMAGE",21),JSONObject(counts).apply{remove("NO_ACK")},JSONObject(counts).put("URL","PRIVATE")))assertNull(ReviewImageChecks.parse(j))
  assertNull(OcrSummary.decode(summary.copy(selected=8).encode()))
 }
 @Test fun twentyChecksFitWithCurrentNestedEvidenceAndCannotExceedBudget(){
  var counts:Map<String,Int> = emptyMap();repeat(20){counts=ReviewImageChecks.add(counts,"NO_PROOF")};assertNotNull(ReviewImageChecks.parse(JSONObject(counts)))
  val evidence=ReviewEvidence.keys.associateWith{0};val completed=ReviewDataSummary("DONE",20,20,20,19,8,8,1,3,evidence,20,20)
  val summary=OcrSummary("DONE",20,3,0,0,0,reviewCompleted=completed,imageChecks=counts)
  assertTrue(summary.encode().length<=4096);assertEquals(summary,OcrSummary.decode(summary.encode()))
  try{ReviewImageChecks.add(counts,"NO_IMAGE");fail("21st check accepted")}catch(_:IllegalArgumentException){}
 }
 @Test fun detailedStagesAreValidatedAndOlderImageMapsRemainReadable(){
  for(code in listOf("NO_MEDIA_DATA","NO_RENDITION","OWNER_FILTER")){
   assertEquals(code,ReviewImageChecks.reply(reply(code),nonce));assertNull(ReviewImageChecks.reply(reply(code,1),nonce))
  }
  val counts=ReviewImageChecks.add(emptyMap(),"NO_PROOF");val old=JSONObject(counts);for(k in listOf("NO_MEDIA_DATA","NO_RENDITION","OWNER_FILTER"))old.remove(k)
  assertEquals(counts,ReviewImageChecks.parse(old));val summary=JSONObject(OcrSummary("DONE",1,0,0,0,0).encode()).put("imageChecks",old)
  val decoded=OcrSummary.decode(summary.toString())!!;assertEquals(counts,decoded.imageChecks);assertTrue(decoded.report().contains("brak powiązania bez szczegółów 1"))
 }
}
