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
}
