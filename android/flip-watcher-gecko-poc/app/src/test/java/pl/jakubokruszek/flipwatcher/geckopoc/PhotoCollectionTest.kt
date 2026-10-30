package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PhotoCollectionTest {
 private fun row(n:Int,offer:Boolean=false)=DesktopRow((550000000000080+n).toString(),"https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/${550000000000080+n}/","DOM",if(offer)260000.0 else null,if(offer)"EXPLICIT_TOTAL"else"NONE",if(offer)45.8 else null,null,null,null,null,if(offer)"SELL_PROPERTY"else"UNKNOWN",offer,0,if(offer)"CANDIDATE"else"NO_TEXT")
 @Test fun recognizedOffersWithoutPhotosPrecedeManualCandidatesAndSavedPhotosAreSkipped(){
  val manual=row(1);val offer=row(2,true);val saved=row(3,true);val excluded=row(4).copy(intent="BUY_PROPERTY")
  val rows=listOf(manual,saved,offer,excluded)
  assertEquals(listOf(offer,manual),PhotoCollection.queue(rows,{it==saved.postId}))
  assertEquals(rows,listOf(manual,saved,offer,excluded))
 }
 @Test fun photoSelectionIncludesAnOfferThatTheTextReviewQueueOmits(){
  val offer=row(1,true);assertTrue(ReviewDataGate.queue(listOf(offer)).isEmpty())
  assertEquals(listOf(offer),PhotoCollection.selected(listOf(offer),listOf(offer.postId),PocPolicy.APPROVED_GROUP_ID))
 }
 @Test fun malformedOrForeignInputNeverCreatesAPhotoQueue(){
  val r=row(1)
  for(rows in listOf(listOf(r,r),listOf(r.copy(permalink=r.permalink.replace(PocPolicy.APPROVED_GROUP_ID,"foreign"))),(1..21).map{row(it)}))assertTrue(PhotoCollection.queue(rows,{false}).isEmpty())
  for(ids in listOf(emptyList(),listOf(r.postId,r.postId),listOf("550000000000099")))assertTrue(PhotoCollection.selected(listOf(r),ids,PocPolicy.APPROVED_GROUP_ID).isEmpty())
 }
 @Test fun aCompletedPhotoDoesNotNeedToBeOpenedAgain(){
  val rows=(1..4).map{row(it,it%2==0)}
  assertTrue(PhotoCollection.queue(rows,{true}).isEmpty());assertEquals(4,PhotoCollection.queue(rows,{false}).size)
 }
 @Test fun photoProgressSurvivesInterruptionWithoutAnyOfferFields(){
  val checks=ReviewImageChecks.add(emptyMap(),"CAPTURED")
  val summary=PhotoSummary("PAUSED",2,1,checks,ReviewDataSummary("PAUSED",2,1,1,1,0,1,0,0))
  assertEquals(summary,PhotoSummary.decode(summary.encode()));assertTrue(summary.brief().contains("OCR nie był uruchamiany"));assertFalse(summary.encode().contains("facebook"));assertFalse(summary.encode().contains(row(1).postId))
 }
 @Test fun savedCountCannotExceedSuccessfulCapturesAndUnknownSummaryFieldsAreRejected(){
  val summary=PhotoSummary("DONE",1,1,ReviewImageChecks.add(emptyMap(),"CAPTURED"))
  assertEquals(summary,PhotoSummary.decode(summary.encode()))
  for(j in listOf(JSONObject(summary.encode()).put("saved",2),JSONObject(summary.encode()).put("selected",21),JSONObject(summary.encode()).put("saved","1"),JSONObject(summary.encode()).put("url","PRIVATE")))assertNull(PhotoSummary.decode(j.toString()))
  assertNull(PhotoSummary.decode(PhotoSummary("DONE",1,1,ReviewImageChecks.add(emptyMap(),"NO_MEDIA_DATA")).encode()))
 }
}
