package pl.jakubokruszek.flipwatcher.geckopoc

import kotlinx.coroutines.CancellationException
import org.json.JSONObject

/** No business fields in persistent summary. OCR candidates never replace accepted DOM fields. */
data class OcrSummary(val reason:String,val selected:Int,val images:Int,val texts:Int,val suggestions:Int,val errors:Int,val reviewFailure:ReviewDataSummary?=null,val reviewCompleted:ReviewDataSummary?=null){
 fun encode()=JSONObject().put("reason",reason).put("selected",selected).put("images",images).put("texts",texts).put("suggestions",suggestions).put("errors",errors).apply{reviewFailure?.let{put("reviewFailure",JSONObject(it.encode()))};reviewCompleted?.let{put("reviewCompleted",JSONObject(it.encode()))}}.toString()
 fun report()=buildString{
  appendLine("OCR 0.5.51 • tylko lokalnie • $reason")
  appendLine("Posty wybrane: $selected • obrazy: $images • odczytane napisy: $texts • wyniki do sprawdzenia: $suggestions • błędy: $errors")
  if(reason=="PARTIAL")appendLine("OCR obrazów z pamięci ukończony; etap otwierania pozostałych postów zatrzymany. Wynik częściowy.")
  (reviewFailure?:reviewCompleted)?.let{
   appendLine(if(it.reason=="DONE")"\nEtap otwierania zakończony." else "\nPrzyczyna etapu otwierania: ${it.reason}. ${it.explanation()}")
   appendLine("Otwarto ${it.opened}/${it.selected} • potwierdzono ${it.bound} • tekst ${it.textRead}."+(if(it.reason!="DONE")" Zatrzymanie nie dowodzi braku ofert." else ""))
   appendLine("Uzupełniono dane: ${it.enriched} • bez nowych pól: ${it.unchanged} • bez odczytanego tekstu: ${it.unresolved} • poza filtrem: ${it.filtered}.")
   if(it.batchSessions>0)appendLine("Sesje robocze otwarte ${it.batchSessions} • zamknięte ${it.batchSessionsClosed}.")
   append(ReviewEvidence.report(it.evidence))
  }
  append("\n\nPola OCR są heurystyczne, oddzielone od danych tekstowych i DO SPRAWDZENIA (także cena za m² i cena wyliczona). Brak odczytu nie dowodzi braku danych. Obrazy i wyniki tylko w RAM; pauza je usuwa. Bez uploadu, skanu i kolektora.")
 }

 companion object{fun decode(raw:String?):OcrSummary?=runCatching{
  if(raw==null||raw.length>4096)return null;val j=JSONObject(raw)
  val keys=j.keys().asSequence().toSet();val required=setOf("reason","selected","images","texts","suggestions","errors")
  if(keys!=required&&keys!=required+"reviewFailure"&&keys!=required+"reviewCompleted")return null
  val failure=if(j.has("reviewFailure"))ReviewDataSummary.decode(j.getJSONObject("reviewFailure").toString())?.takeIf{it.reason!="DONE"}?:return null else null
  val completed=if(j.has("reviewCompleted"))ReviewDataSummary.decode(j.getJSONObject("reviewCompleted").toString())?.takeIf{it.reason=="DONE"}?:return null else null
  if(j.optString("reason") !in setOf("DONE","NO_CONSENT","CONTEXT","TIMEOUT","CANCELLED","PAUSED","ERROR","INTERRUPTED","PROTOCOL","PARTIAL"))return null
  val c=listOf("selected","images","texts","suggestions","errors").map{k->val n=j.opt(k);if(n !is Int||n !in 0..20)return null;n}
  if(c[2]>c[1]||c[3]>c[0]||c[4]>c[1]||c[2]+c[4]>c[1]||c[1]>c[0]*3)return null
  if(failure!=null&&(failure.selected>c[0]||j.getString("reason")=="DONE"))return null
  if(j.getString("reason")=="PARTIAL"&&(failure?.reason!="NO_OWN_POST"||c[1]==0))return null
  if(completed!=null&&(completed.selected>c[0]||j.getString("reason")!="DONE"))return null
  OcrSummary(j.getString("reason"),c[0],c[1],c[2],c[3],c[4],failure,completed)
 }.getOrNull()}
}
object OcrProtocol{
 fun parse(j:JSONObject?,nonce:String,id:String):DesktopRow?{
  if(j?.optString("type")!="ocrFieldsResult")return null
  val common=JSONObject(j.toString()).put("type","desktopPreviewResult")
  val r=DesktopProtocol.parse(common,nonce)?:return null
  return r.rows.singleOrNull()?.takeIf{r.status=="OK"&&it.postId==id}
 }
}
object OcrBatch{
 data class Outcome(val summary:OcrSummary,val rows:Map<String,DesktopRow>)
 suspend fun run(rows:List<DesktopRow>,consent:Boolean,available:(String)->Int,alive:()->Boolean,
                 read:suspend(String,Int)->String?,project:suspend(String,List<String>)->DesktopRow?,
                 now:()->Long,snapshot:(OcrSummary)->Unit={}):Outcome{
  var images=0;var texts=0;var errors=0;val result=linkedMapOf<String,DesktopRow>()
  val valid=rows.size<=20&&rows.map{it.postId}.distinct().size==rows.size&&rows.all{ReviewDataGate.matches(it.permalink,PocPolicy.APPROVED_GROUP_ID,it.postId)}
  val queue=if(valid)rows.filter{(DesktopPresentation.reviewable(it)||DesktopSummary.eligible(it))&&available(it.postId) in 1..3}.sortedBy{if(DesktopPresentation.reviewable(it))0 else 1}else emptyList()
  val start=now();fun summary(reason:String)=OcrSummary(reason,queue.size,images,texts,result.size,errors)
  fun done(reason:String):Outcome{val s=summary(reason);snapshot(s);return Outcome(s,if(reason=="DONE")result.toMap()else emptyMap())}
  if(!consent)return done("NO_CONSENT");if(!valid||!alive())return done("CONTEXT")
  val recognizedByPost=mutableMapOf<String,MutableList<String>>()
  // Visit every available post before spending the image budget on extra views.
  for(index in 0..2)for(row in queue){
   if(images>=20)break
   if(index>=available(row.postId).coerceIn(0,3))continue
   val recognized=recognizedByPost.getOrPut(row.postId){mutableListOf()}
   var chars=recognized.sumOf{it.length}
   run {
    if(!alive())return done("CONTEXT");if(now()-start>=120000)return done("TIMEOUT");
    images++;snapshot(summary("INTERRUPTED"))
    val text=try{read(row.postId,index)?.take(12000)?.trim()}catch(e:CancellationException){throw e}catch(_:Exception){errors++;null}
    if(!alive())return done("CONTEXT");if(now()-start>=120000)return done("TIMEOUT")
    if(!text.isNullOrEmpty()){texts++;if(chars+text.length<=24000){recognized.add(text);chars+=text.length}}
   }
   if(recognized.isNotEmpty()){
    if(!alive())return done("CONTEXT")
    val parsed=project(row.postId,recognized)?:return done("PROTOCOL")
    if(!alive())return done("CONTEXT")
    if(parsed.postId!=row.postId||parsed.permalink!=row.permalink)return done("PROTOCOL")
    result[row.postId]=parsed
   }
   snapshot(summary("INTERRUPTED"));if(images>=20)break
  }
  return done("DONE")
 }
}
