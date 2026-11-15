package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class FrameTimingProtocolTest {
 private fun reply()=JSONObject().put("type","frameTimingResult").put("nonce","n").put("token","t").put("status","OK")
  .put("stats",JSONObject(FrameTimingProtocol.fields.associateWith{0}).put("elapsedMs",25000).put("timerCount",25))
 @Test fun frozenAnimationWithLiveTimerIsValidEvidence(){
  val value=FrameTimingProtocol.parse(reply(),"n","t")!!
  assertEquals(0,value["rafCount"]);assertEquals(25,value["timerCount"])
 }
 @Test fun rejectsStaleDocumentTokenNonceAndUnexpectedPayload(){
  assertNull(FrameTimingProtocol.parse(reply(),"other","t"))
  assertNull(FrameTimingProtocol.parse(reply(),"n","other"))
  assertNull(FrameTimingProtocol.parse(reply().put("text","private"),"n","t"))
  assertNull(FrameTimingProtocol.parse(reply().apply{getJSONObject("stats").put("url","private")},"n","t"))
 }
 @Test fun rejectsNonIntegerNegativeOversizeAndNonNumericCounters(){
  for(bad in listOf(-1,0.5,100000001,"1",JSONObject.NULL)){
   assertNull("bad=$bad",FrameTimingProtocol.parse(reply().apply{getJSONObject("stats").put("rafCount",bad)},"n","t"))
  }
  assertNull(FrameTimingProtocol.parse(reply().apply{getJSONObject("stats").put("visibleNow",2)},"n","t"))
 }
 @Test fun rejectsMissingCounterAndStoppedReply(){
  assertNull(FrameTimingProtocol.parse(reply().apply{getJSONObject("stats").remove("hasRaf")},"n","t"))
  assertNull(FrameTimingProtocol.parse(reply().put("status","STOP"),"n","t"))
 }
}
