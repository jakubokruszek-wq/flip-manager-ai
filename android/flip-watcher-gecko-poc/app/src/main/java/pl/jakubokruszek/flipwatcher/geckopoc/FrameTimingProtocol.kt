package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject

/** Count-only diagnostic; never authorizes offer extraction or image capture. */
internal object FrameTimingProtocol {
 val fields=setOf("elapsedMs","rafCount","timerCount","visibilityChanges","visibleStart","visibleNow","hasRaf","hasTimer","rafLastAgeMs","timerLastAgeMs")
 fun parse(reply:JSONObject?,nonce:String,token:String):Map<String,Int>? {
  if(reply==null||reply.keys().asSequence().toSet()!=setOf("type","nonce","token","status","stats")||
   reply.optString("type")!="frameTimingResult"||reply.optString("nonce")!=nonce||reply.optString("token")!=token||reply.optString("status")!="OK")return null
  val stats=reply.optJSONObject("stats")?:return null
  if(stats.keys().asSequence().toSet()!=fields)return null
  val result=mutableMapOf<String,Int>()
  for(key in fields){
   val raw=stats.opt(key) as? Number?:return null
   val value=raw.toDouble()
   if(!value.isFinite()||value%1.0!=0.0||value !in 0.0..100_000_000.0)return null
   if(key in setOf("visibleStart","visibleNow","hasRaf","hasTimer")&&value>1)return null
   result[key]=value.toInt()
  }
  return result
 }
}
