package pl.jakubokruszek.flipwatcher.geckopoc
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
class BackgroundPosterOcrTest {
 private fun row()=DesktopRow("1655103482946823","https://www.facebook.com/groups/297408205383031/posts/1655103482946823/","DOM",null,"NONE",null,null,null,null,null,"UNKNOWN",false,1,"NO_TEXT")
 private fun sale()=row().copy(price=368000.0,priceSource="THOUSANDS_TOTAL",area=62.4,intent="SELL_PROPERTY",usable=true,qualification="CANDIDATE")
 @Test fun exactPosterBecomesSaleWithActualPhotoAndPreservesUnknownRooms(){val merged=BackgroundPosterOcr.merge(row(),sale());assertEquals(368000.0,merged.price);assertEquals(62.4,merged.area);assertNull(merged.rooms);assertNull(OfferQuality.reason(merged,1));assertEquals("PHOTO_REQUIRED",OfferQuality.reason(merged,0))}
 @Test fun wrongPostGroupConflictingDomAndNegativeIntentNeverPromote(){
  assertEquals(row(),BackgroundPosterOcr.merge(row(),sale().copy(postId="999999")))
  assertEquals(row(),BackgroundPosterOcr.merge(row(),sale().copy(permalink=sale().permalink.replace("297408205383031","foreign"))))
  for(intent in listOf("BUY_PROPERTY","RENT_OFFER","RENT_WANTED","SERVICE","OTHER")){val original=row().copy(intent=intent);assertEquals(original,BackgroundPosterOcr.merge(original,sale()))}
  for(q in listOf("FOREIGN_CITY","CONFLICT","INTENT")){val original=row().copy(qualification=q);assertEquals(original,BackgroundPosterOcr.merge(original,sale()))}
  val dom=row().copy(price=450000.0,priceSource="EXPLICIT_TOTAL");assertEquals(dom,BackgroundPosterOcr.merge(dom,sale()))
 }
 @Test fun backgroundReadsOnlyBoundCropsAndContinuesAfterOneOcrFailure()=runBlocking {
  val first=row();val second=row().copy(postId="1655103482946824",permalink=row().permalink.replace("1655103482946823","1655103482946824"));var reads=0;val phases=mutableListOf<String>()
  val result=BackgroundPosterOcr.run(listOf(first,second),{true},{1},read={id,_->reads++;if(id==first.postId)error("OCR_FAILED")else "62,4m2 Cena 368K"},project={id,_->sale().copy(postId=id,permalink=second.permalink)},now={0},progress={phases.add(it)})
  assertEquals(2,reads);assertEquals(first,result[0]);assertEquals("SELL_PROPERTY",result[1].intent);assertTrue(phases.all{it=="OCR"})
 }
 @Test fun cancellationAndTimeBudgetReturnOriginalWithoutFurtherReads()=runBlocking {
  var reads=0;val original=listOf(row());val result=BackgroundPosterOcr.run(original,{false},{1},read={_,_->reads++;"text"},project={_,_->sale()},now={0});assertEquals(original,result);assertEquals(0,reads)
  var now=0L;val timed=BackgroundPosterOcr.run(original,{true},{1},read={_,_->reads++;"text"},project={_,_->sale()},now={now.also{now+=45000}});assertEquals(original,timed);assertEquals(0,reads)
 }
}
