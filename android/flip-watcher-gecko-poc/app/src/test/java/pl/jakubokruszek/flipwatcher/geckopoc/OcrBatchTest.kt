package pl.jakubokruszek.flipwatcher.geckopoc

import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class OcrBatchTest{
 private fun row(n:Int=1)=DesktopRow((550000000000080+n).toString(),"https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/${550000000000080+n}/","DOM",null,"NONE",null,null,null,null,null,"UNKNOWN",false,0,"NO_TEXT")
 private fun suggestion(id:String)=row().copy(postId=id,permalink="https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/$id/",price=260000.0,priceSource="EXPLICIT_TOTAL",area=45.8,intent="SELL_PROPERTY",usable=true,qualification="CANDIDATE")
 @Test fun noFreshConsentNeverReadsPixelsOrProjectsText()=runBlocking{
  var calls=0;val out=OcrBatch.run(listOf(row()),false,{1},{true},{_,_->calls++;"PRIVATE"},{_,_->calls++;null},{0})
  assertEquals("NO_CONSENT",out.summary.reason);assertEquals(0,calls);assertTrue(out.rows.isEmpty())
 }
 @Test fun fieldsAreSeparateAndOnlyRequestedIdentityCanReturn()=runBlocking{
  val original=row();val out=OcrBatch.run(listOf(original),true,{1},{true},{_,_->"Sprzedam mieszkanie 45,8m2 za 260000 zł"},{id,_->suggestion(id)},{0})
  assertEquals("DONE",out.summary.reason);assertNull(original.price);assertEquals(260000.0,out.rows[original.postId]!!.price!!,0.0)
  val wrong=OcrBatch.run(listOf(original),true,{1},{true},{_,_->"x"},{_,_->suggestion(row(2).postId)},{0});assertEquals("PROTOCOL",wrong.summary.reason);assertTrue(wrong.rows.isEmpty())
 }
 @Test fun changedContextAfterModelReadDiscardsAllOcrRows()=runBlocking{
  var alive=true;var projections=0;val out=OcrBatch.run(listOf(row()),true,{1},{alive},{_,_->alive=false;"PRIVATE"},{id,_->projections++;suggestion(id)},{0})
  assertEquals("CONTEXT",out.summary.reason);assertTrue(out.rows.isEmpty());assertEquals(0,projections)
 }
 @Test fun deadlineAndImageBudgetCannotBeExtendedByNewPosts()=runBlocking{
  var now=0L;val timed=OcrBatch.run(listOf(row()),true,{1},{true},{_,_->now=120001;"PRIVATE"},{id,_->suggestion(id)},{now})
  assertEquals("TIMEOUT",timed.summary.reason);assertTrue(timed.rows.isEmpty())
  var reads=0;val bounded=OcrBatch.run((1..20).map{row(it)},true,{3},{true},{_,_->reads++;"x"},{id,_->suggestion(id)},{0})
  assertEquals(20,reads);assertEquals(20,bounded.summary.images);assertTrue(bounded.rows.size<=20)
 }
 @Test fun foreignOrDuplicateSourceNeverReadsAnyImage()=runBlocking{
  for(rows in listOf(listOf(row().copy(permalink="https://www.facebook.com/groups/foreign/posts/${row().postId}/")),listOf(row(),row()),(1..21).map{row(it)})){
   var reads=0;val out=OcrBatch.run(rows,true,{1},{true},{_,_->reads++;"PRIVATE"},{id,_->suggestion(id)},{0});assertEquals("CONTEXT",out.summary.reason);assertEquals(0,reads)
  }
 }
 @Test fun cancelNeverPublishesLateResultsButKeepsOnlyNumericProgress()=runBlocking{
  var outcome:OcrBatch.Outcome?=null;val snapshots=mutableListOf<OcrSummary>();var reading=false
  val task=launch{outcome=OcrBatch.run(listOf(row()),true,{1},{true},{_,_->reading=true;awaitCancellation()},{id,_->suggestion(id)},{0},{snapshots.add(it)})}
  while(!reading)yield();task.cancelAndJoin();assertNull(outcome);assertTrue(snapshots.isNotEmpty());assertEquals(1,snapshots.last().images);assertFalse(snapshots.last().encode().contains(row().postId))
 }
 @Test fun numericSummaryPersistsWithoutTextImagesOrIdentifiers(){
  val summary=OcrSummary("DONE",2,3,2,1,1);assertEquals(summary,OcrSummary.decode(summary.encode()));assertFalse(summary.encode().contains("http"));assertFalse(summary.encode().contains(row().postId));assertTrue(summary.report().contains("oddzielone"))
  assertNull(OcrSummary.decode(summary.encode().replace("DONE","PRIVATE_TEXT")));assertNull(OcrSummary.decode(summary.encode().replace("\"images\":3","\"images\":21")))
 }
 @Test fun exactOpeningFailureSurvivesOcrHistoryWithoutBeingMisreportedAsNoImages(){
  for(reason in listOf("NAVIGATION","PAGE_TIMEOUT","LOCATION_TIMEOUT","PORT_TIMEOUT","FOCUS_TIMEOUT","DOM_TIMEOUT","PORT_LOST","DEADLINE","VERIFICATION_OR_LOGIN")){
   val review=ReviewDataSummary(reason,9,1,0,0,0,0,0,0)
   val value=OcrSummary("CONTEXT",9,0,0,0,0,review)
   assertEquals(value,OcrSummary.decode(value.encode()));assertTrue(value.report().contains("Przyczyna etapu otwierania: $reason"));assertTrue(value.report().contains("Otwarto 1/9"));assertFalse(value.encode().contains(row().postId))
  }
  val old="{\"reason\":\"DONE\",\"selected\":1,\"images\":1,\"texts\":1,\"suggestions\":1,\"errors\":0}"
  assertNotNull(OcrSummary.decode(old));assertNull(OcrSummary.decode(OcrSummary("CONTEXT",9,0,0,0,0,ReviewDataSummary("DONE",9,1,0,0,0,0,0,0)).encode()))
 }

 @Test fun missingDataGetsPriorityAndEveryPostGetsOneImageBeforeExtraViews()=runBlocking{
  val manual=(1..19).map{row(it)};val offer=suggestion(row(20).postId)
  val reads=mutableListOf<Pair<String,Int>>()
  val out=OcrBatch.run(listOf(offer)+manual,true,{3},{true},{id,index->reads.add(id to index);"x"},{id,_->suggestion(id)},{0})
  assertEquals("DONE",out.summary.reason);assertEquals(20,reads.size)
  assertEquals(manual.map{it.postId}+offer.postId,reads.map{it.first})
  assertTrue(reads.all{it.second==0});assertEquals(20,out.rows.size)
 }

 @Test fun completedCacheAndFailedSmallerOpeningQueueAreReportedAsPartialWithoutRawData(){
  val opening=ReviewDataSummary("NO_OWN_POST",14,2,0,0,0,0,2,0)
  val value=OcrSummary("PARTIAL",18,7,4,4,0,opening)
  assertEquals(value,OcrSummary.decode(value.encode()))
  assertTrue(value.report().contains("Otwarto 2/14"));assertTrue(value.report().contains("Wynik częściowy"))
  assertFalse(value.encode().contains(row().postId))
  assertNull(OcrSummary.decode(value.copy(reviewFailure=null).encode()))
  assertNull(OcrSummary.decode(value.copy(selected=13).encode()))
  assertNull(OcrSummary.decode(value.copy(images=0,texts=0,suggestions=0).encode()))
 }
 @Test fun successfulCombinedRunIncludesOpeningCountersAndStillReadsLegacyCacheReports(){
  val opening=ReviewDataSummary("DONE",2,2,2,2,1,1,0,0)
  val value=OcrSummary("DONE",3,3,2,2,0,reviewCompleted=opening)
  assertEquals(value,OcrSummary.decode(value.encode()));assertTrue(value.report().contains("Otwarto 2/2"))
  assertFalse(value.report().contains("Zatrzymanie"))
  assertNull(OcrSummary.decode(value.copy(reason="CONTEXT").encode()))
  assertNull(OcrSummary.decode(value.copy(reviewCompleted=opening.copy(reason="NO_OWN_POST")).encode()))
  assertNotNull(OcrSummary.decode(OcrSummary("DONE",1,1,1,1,0).encode()))
 }

}
