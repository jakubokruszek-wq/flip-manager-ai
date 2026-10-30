package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PhotoBindingDetailsTest {
 @Test fun legacyDiagnosisRemainsReadableWithUnmeasuredCountersZero(){
  val old=setOf("documentImg","rawImg","rawSvg","rawCss","sourceProof","ownerAccepted","ownerRejected","sizeRejected","qualified").associateWith{0}
  val result=ReviewImageChecks.details(JSONObject().put("details",JSONObject(old)))!!
  assertEquals(ReviewImageChecks.detailKeys,result.keys);assertEquals(0,result.getValue("sourceAsset"))
  val stored=PhotoDiagnosis("550000000000091","NO_IMAGE",old,emptyMap())
  val restored=PhotoDiagnosis.decode(stored.encode())!!;assertTrue(restored.report().contains("ten sam plik CDN 0"))
 }
 @Test fun numericBindingReasonsRoundTripWithoutAnyPhotoUrl(){
  val values=ReviewImageChecks.detailKeys.associateWith{0}.toMutableMap().apply{put("documentImg",68);put("rawImg",68);put("sourceProof",5);put("ownerRejected",68);put("sourceAsset",5);put("noArticle",5)}
  val value=PhotoDiagnosis("550000000000091","NO_IMAGE",values,emptyMap())
  assertEquals(value,PhotoDiagnosis.decode(value.encode()));assertTrue(value.report().contains("brak article 5"));assertFalse(value.encode().contains("fbcdn"))
 }
 @Test fun unknownFieldsStringsAndOutOfBoundsReasonsAreRejected(){
  for((key,value) in listOf("sourceUri" to "https://example.org/photo", "sourceAsset" to "5", "foreignOwner" to 701)){
   val d=JSONObject(ReviewImageChecks.detailKeys.associateWith{0}).put(key,value)
   assertNull(ReviewImageChecks.details(JSONObject().put("details",d)))
  }
 }
 @Test fun previousSixteenCounterDiagnosisGetsZeroForNewSourceScopeCounter(){
  val old=ReviewImageChecks.detailKeys.filter{it!="sourceOwner"&&it !in ReviewImageChecks.regionDetailKeys}.associateWith{0}
  val restored=PhotoDiagnosis.decode(PhotoDiagnosis("550000000000091","NO_IMAGE",old,emptyMap()).encode())!!
  assertEquals(0,restored.details.getValue("sourceOwner"));assertTrue(restored.report().contains("własne źródło bez linku 0"))
 }
 @Test fun previousSeventeenCounterDiagnosisGetsZeroForRegionCounters(){
  val old=ReviewImageChecks.detailKeys.filter{it !in ReviewImageChecks.regionDetailKeys}.associateWith{0}
  val restored=PhotoDiagnosis.decode(PhotoDiagnosis("550000000000091","NO_IMAGE",old,emptyMap()).encode())!!
  for(key in ReviewImageChecks.regionDetailKeys)assertEquals(0,restored.details.getValue(key))
 }
 @Test fun regionReasonsRoundTripWithoutAllowingStringsOrUnknownFields(){
  val values=ReviewImageChecks.detailKeys.associateWith{if(it in ReviewImageChecks.regionDetailKeys)5 else 0}
  val diagnosis=PhotoDiagnosis("550000000000091","NO_IMAGE",values,emptyMap());assertEquals(diagnosis,PhotoDiagnosis.decode(diagnosis.encode()))
  assertTrue(diagnosis.report().contains("niezależne obszary 5"))
  for(key in ReviewImageChecks.regionDetailKeys){val bad=JSONObject(values).put(key,"5");assertNull(ReviewImageChecks.details(JSONObject().put("details",bad)))}
 }
 @Test fun exactSourceScopeCountersRoundTripAndCannotExceedAcceptedOrExactMatches(){
  val values=ReviewImageChecks.detailKeys.associateWith{0}.toMutableMap().apply{put("documentImg",61);put("rawImg",61);put("sourceProof",5);put("sourceExact",5);put("sourceOwner",5);put("noArticle",5);put("ownerAccepted",5);put("qualified",5)}
  val diagnosis=PhotoDiagnosis("550000000000091","CAPTURED",values,emptyMap());assertEquals(diagnosis,PhotoDiagnosis.decode(diagnosis.encode()))
  for(key in listOf("ownerAccepted","sourceExact")){val bad=values.toMutableMap().apply{put(key,4)};assertNull(ReviewImageChecks.details(JSONObject().put("details",JSONObject(bad))))}
 }
}
