package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject

/** Count-only outcomes: never accept source URLs, identifiers or OCR text. */
object ReviewImageChecks{
 val outcomes=setOf("CAPTURED","NO_PROOF","NO_IMAGE","UNLOADED","OCCLUDED","NO_ACK","AMBIGUOUS","CONTEXT","PROTOCOL")
 private val keys=outcomes+"checked"
 fun reply(j:JSONObject?,nonce:String):String?{
  if(j==null||j.keys().asSequence().toSet()!=setOf("type","nonce","status","count","reason")||j.optString("type")!="reviewImagesResult"||j.optString("nonce")!=nonce)return null
  val reason=j.opt("reason");val count=j.opt("count");val status=j.opt("status")
  if(reason !is String||reason !in outcomes-"PROTOCOL"||count !is Int||count !in 0..1)return null
  if(reason=="CONTEXT")return reason.takeIf{status=="STOP"&&count==0}
  if(status!="OK"||(reason=="CAPTURED")!=(count==1))return null
  return reason
 }
 fun add(before:Map<String,Int>,reason:String):Map<String,Int>{
  require(reason in outcomes);val value=if(before.isEmpty())keys.associateWith{0}.toMutableMap()else before.toMutableMap()
  require(value.getValue("checked")<20);value["checked"]=value.getValue("checked")+1;value[reason]=value.getValue(reason)+1;return value.toMap()
 }
 fun parse(j:JSONObject?):Map<String,Int>?{
  if(j==null||j.keys().asSequence().toSet()!=keys)return null
  val counts=keys.associateWith{k->val n=j.opt(k);if(n !is Int||n !in 0..20)return null;n}
  if(counts.getValue("checked") !in 1..20||outcomes.sumOf{counts.getValue(it)}!=counts.getValue("checked"))return null
  return counts
 }
 fun report(v:Map<String,Int>)="Zdjęcia otwartych postów: sprawdzono ${v.getValue("checked")} • wycinki ${v.getValue("CAPTURED")} • brak powiązania ${v.getValue("NO_PROOF")} • brak kwalifikującego obrazu ${v.getValue("NO_IMAGE")} • niezaładowane/za małe ${v.getValue("UNLOADED")} • geometria/zasłonięcie ${v.getValue("OCCLUDED")} • brak ACK ${v.getValue("NO_ACK")} • niejednoznaczne ${v.getValue("AMBIGUOUS")} • utrata kontekstu ${v.getValue("CONTEXT")} • protokół ${v.getValue("PROTOCOL")}."
}
