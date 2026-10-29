package pl.jakubokruszek.flipwatcher.geckopoc

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject

class SavedOcrTest {
 private fun row(n:Int=1)=DesktopRow("55000000000009$n","https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/55000000000009$n/","DOM",null,"NONE",null,null,null,null,null,"UNKNOWN",false,1,"NO_TEXT")
 private fun result(r:DesktopRow)=r.copy(price=260000.0,priceSource="EXPLICIT_TOTAL",area=45.8,usable=true,intent="SELL_PROPERTY")
 private fun value(crop:Boolean=true)=SavedResult(123,listOf(row()),emptyList(),listOf(SavedPhoto(row().postId,0,crop,byteArrayOf(1))))
 @Test fun savedCropIsProcessedWithoutAnyBrowserInputAndFieldsRemainSeparate()=runBlocking{
  val checkpoints=mutableListOf<List<DesktopRow>>();val source=value()
  val out=SavedOcr.run(source,true,{true},{"260000 zl 45,8 m2"},{_,_->result(row())},{0},checkpoint={checkpoints.add(it)})
  assertEquals("DONE",out.summary.reason);assertEquals(1,out.summary.images);assertEquals(1,out.summary.suggestions)
  assertNull(source.rows.single().price);assertEquals(260000.0,checkpoints.last().single().price!!,0.0)
 }
 @Test fun thumbnailsAndMissingConsentNeverReachRecognition()=runBlocking{
  var reads=0
  for((v,consent) in listOf(value(false) to true,value() to false))SavedOcr.run(v,consent,{true},{reads++;"x"},{_,_->result(row())},{0})
  assertEquals(0,reads)
 }
 @Test fun oldSuggestionSurvivesAnEmptyNewRead()=runBlocking{
  val source=value().copy(ocr=listOf(result(row())))
  val out=SavedOcr.run(source,true,{true},{""},{_,_->result(row())},{0})
  assertTrue(out.rows.isEmpty());assertEquals(260000.0,source.ocr.single().price!!,0.0)
 }
 @Test fun wrongIdentityAndStoppedContextNeverCheckpoint()=runBlocking{
  var checkpoints=0
  val out=SavedOcr.run(value(),true,{true},{"x"},{_,_->result(row(2))},{0},checkpoint={checkpoints++})
  assertEquals("PROTOCOL",out.summary.reason);assertEquals(0,checkpoints)
  val stopped=SavedOcr.run(value(),true,{false},{"x"},{_,_->result(row())},{0},checkpoint={checkpoints++})
  assertEquals("CONTEXT",stopped.summary.reason);assertEquals(0,checkpoints)
 }
 @Test fun selectedPostQueueIncludesOnlyTheExplicitCanonicalOffer(){
  val offer=result(row(2));assertEquals(listOf(offer),ReviewDataGate.queue(listOf(row(),offer),selectedPostId=offer.postId))
  assertTrue(ReviewDataGate.queue(listOf(row(),offer),selectedPostId="999999").isEmpty())
  assertTrue(ReviewDataGate.queue(listOf(offer.copy(permalink="https://example.org/")),selectedPostId=offer.postId).isEmpty())
 }
 @Test fun diagnosisRejectsRawSourceAndUnboundedCounters(){
  val details=ReviewImageChecks.detailKeys.associateWith{0};val value=PhotoDiagnosis(row().postId,"NO_IMAGE",details,emptyMap())
  assertEquals(value,PhotoDiagnosis.decode(value.encode()));assertFalse(value.encode().contains("facebook"))
  assertNull(PhotoDiagnosis.decode(JSONObject(value.encode()).put("rawHtml","private").toString()))
  assertNull(PhotoDiagnosis.decode(JSONObject(value.encode()).put("details",JSONObject(details).put("rawImg",701)).toString()))
 }
 @Test fun briefReportSeparatesSummaryFromDetailedEvidence(){
  val value=OcrSummary("DONE",1,1,1,1,0)
  assertTrue(value.brief().contains("sugestie do sprawdzenia: 1"));assertFalse(value.brief().contains("Parser:"));assertTrue(value.brief().contains("Diagnostyka"))
 }
}
