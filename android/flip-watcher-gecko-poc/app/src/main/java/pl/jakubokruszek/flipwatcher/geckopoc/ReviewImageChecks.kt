package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject

/** Count-only outcomes: never accept source URLs, identifiers or OCR text. */
object ReviewImageChecks{
 private val legacyOutcomes=setOf("CAPTURED","NO_PROOF","NO_IMAGE","UNLOADED","OCCLUDED","NO_ACK","AMBIGUOUS","CONTEXT","PROTOCOL")
 val outcomes=legacyOutcomes+setOf("NO_MEDIA_DATA","NO_RENDITION","OWNER_FILTER")
 val ruleKeys=setOf("RULE_PATH","RULE_FOREIGN","RULE_STORY","RULE_OPAQUE","RULE_SIZE","RULE_SCOPE")
 private val keys=outcomes+"checked"+ruleKeys
 fun reply(j:JSONObject?,nonce:String):String?{
  if(j==null)return null
  val shape=setOf("type","nonce","status","count","reason");val actual=j.keys().asSequence().toSet()
  if((actual!=shape&&actual!=shape+"filters")||filters(j)==null||j.optString("type")!="reviewImagesResult"||j.optString("nonce")!=nonce)return null
  val reason=j.opt("reason");val count=j.opt("count");val status=j.opt("status")
  if(reason !is String||reason !in outcomes-"PROTOCOL"||count !is Int||count !in 0..1)return null
  if(reason=="CONTEXT")return reason.takeIf{status=="STOP"&&count==0}
  if(status!="OK"||(reason=="CAPTURED")!=(count==1))return null
  return reason
 }
 fun filters(j:JSONObject?):Map<String,Int>?{
  if(j==null)return null;if(!j.has("filters"))return emptyMap()
  val f=j.optJSONObject("filters")?:return null;if(f.keys().asSequence().toSet()!=ruleKeys)return null
  return ruleKeys.associateWith{k->val n=f.opt(k);if(n !is Int||n !in 0..1)return null;n}
 }
 fun add(before:Map<String,Int>,reason:String,filters:Map<String,Int> = emptyMap()):Map<String,Int>{
  require(reason in outcomes&&filters.keys.all{it in ruleKeys}&&filters.values.all{it in 0..1});val value=keys.associateWith{before[it]?:0}.toMutableMap()
  require(value.getValue("checked")<20);value["checked"]=value.getValue("checked")+1;value[reason]=value.getValue(reason)+1;for(k in ruleKeys)value[k]=value.getValue(k)+(filters[k]?:0);return value.toMap()
 }
 fun parse(j:JSONObject?):Map<String,Int>?{
  if(j==null)return null
  val actual=j.keys().asSequence().toSet();if(actual!=keys&&actual!=outcomes+"checked"&&actual!=legacyOutcomes+"checked")return null
  val counts=keys.associateWith{k->val n=if(k in actual)j.opt(k)else 0;if(n !is Int||n !in 0..20)return null;n}
  if(counts.getValue("checked") !in 1..20||outcomes.sumOf{counts.getValue(it)}!=counts.getValue("checked")||ruleKeys.any{counts.getValue(it)>counts.getValue("checked")})return null
  return counts
 }
 fun report(v:Map<String,Int>)="Zdjęcia otwartych postów: sprawdzono ${v.getValue("checked")} • wycinki ${v.getValue("CAPTURED")} • brak powiązania bez szczegółów ${v.getValue("NO_PROOF")} • brak Photo/Image w analizowanych danych ${v.getValue("NO_MEDIA_DATA")} • brak URI obrazu ${v.getValue("NO_RENDITION")} • odrzucone media ${v.getValue("OWNER_FILTER")} • brak kwalifikującego obrazu ${v.getValue("NO_IMAGE")} • niezaładowane/za małe ${v.getValue("UNLOADED")} • geometria/zasłonięcie ${v.getValue("OCCLUDED")} • brak ACK ${v.getValue("NO_ACK")} • niejednoznaczne ${v.getValue("AMBIGUOUS")} • utrata kontekstu ${v.getValue("CONTEXT")} • protokół ${v.getValue("PROTOCOL")}.\nReguły odrzucające w analizowanych blokach (próby, mogą się nakładać): komentarz/autor/wideo ${v.getValue("RULE_PATH")} • obca tożsamość/link ${v.getValue("RULE_FOREIGN")} • niepotwierdzona sekcja Story ${v.getValue("RULE_STORY")} • niezgodny identyfikator sekcji ${v.getValue("RULE_OPAQUE")} • rozmiar ${v.getValue("RULE_SIZE")} • brak własnego kontenera danych ${v.getValue("RULE_SCOPE")}."
}
