package pl.jakubokruszek.flipwatcher.geckopoc

import java.net.URI
import org.json.JSONObject

/** A separate one-time grant for current RAM review rows; never a scan grant. */
class ReviewDataGate(private val group:String,private val fixture:Boolean=false,private val now:()->Long){
    private val started=now()
    var active=true;private set
    var reason="RUNNING";private set
    var expectedId:String?=null;private set
    var currentUrl:String?=null;private set
    var requests=0;private set
    private var seenRequest=false
    private var hasBoundDocument=false
    private var sessionOpen=false
    private var sessionGeneration=0
    fun beginSession():Int{
        if(!tick()||sessionOpen){stop("CONTEXT");return 0}
        sessionGeneration++;sessionOpen=true
        expectedId=null;currentUrl=null;requests=0;seenRequest=false;hasBoundDocument=false
        return sessionGeneration
    }
    fun acceptsSession(generation:Int)=tick()&&sessionOpen&&generation==sessionGeneration
    fun endSession(generation:Int){if(generation==sessionGeneration)sessionOpen=false}
    fun stop(code:String){if(active){active=false;reason=code}}
    fun tick():Boolean{if(active&&now()-started>=180_000)stop("DEADLINE");return active}
    fun expect(id:String){if(!tick()||!Regex("^[0-9]{5,30}$").matches(id)){stop("INPUT");return};expectedId=id;currentUrl=null;requests=0;seenRequest=false}
    fun request(raw:String,newWindow:Boolean=false,userGesture:Boolean=false):Boolean{
        if(!tick())return false
        if(raw=="about:blank"&&!seenRequest&&!newWindow&&!userGesture)return true
        if(newWindow||userGesture||expectedId==null||!matches(raw,group,expectedId!!,fixture)||++requests>4){stop("NAVIGATION");return false}
        seenRequest=true;return true
    }
    fun location(raw:String?):Boolean{
        // Gecko reports the initial empty document asynchronously, even after native loadUri.
        // It cannot establish context and is ignored only before the first exact document.
        if((raw==null||raw=="about:blank")&&!hasBoundDocument)return tick()
        if(!tick()||!seenRequest||expectedId==null||!matches(raw,group,expectedId!!,fixture)){stop("CONTEXT");return false}
        hasBoundDocument=true;currentUrl=raw;return true
    }
    companion object{
        fun matches(raw:String?,group:String,id:String,fixture:Boolean=false):Boolean=runCatching{
            val u=URI(raw?:return false)
            Regex("^[A-Za-z0-9._-]{1,100}$").matches(group)&&Regex("^[0-9]{5,30}$").matches(id)&&u.rawUserInfo==null&&u.rawQuery==null&&u.rawFragment==null&&
            ((u.scheme=="https"&&u.port==-1&&u.host?.lowercase() in setOf("facebook.com","www.facebook.com","m.facebook.com"))||(fixture&&u.scheme=="http"&&u.host=="127.0.0.1"&&u.port in 1..65535))&&
            u.rawPath in setOf("/groups/$group/posts/$id","/groups/$group/posts/$id/","/groups/$group/permalink/$id","/groups/$group/permalink/$id/")
        }.getOrDefault(false)
        fun queue(rows:List<DesktopRow>,group:String=PocPolicy.APPROVED_GROUP_ID)=rows.take(20).filter{DesktopPresentation.reviewable(it)&&it.permalink=="https://www.facebook.com/groups/$group/posts/${it.postId}/"&&matches(it.permalink,group,it.postId)}.distinctBy{it.postId}.sortedWith(compareBy<DesktopRow>{if(it.qualification=="NO_TEXT")0 else 1}.thenBy{ReviewDataSummary.fields(it)})
    }
}

object ReviewEvidence{
 val legacyKeys=setOf("articleNodes","boundCards","nestedCards","foreignParents","messageNodes","scriptNodes","scriptParsed","scriptMatched","scriptSkipped","budgetLimited","readerStage","readerErrors")
 val v540Keys=legacyKeys+setOf("hrefExact","attrExact","identityMissing","foreignGroup","foreignPost","commentIdentity","excludedCards","manyLinks")
 val v541Keys=v540Keys+setOf("rejectQuery","rejectRegion","canonicalSeen","canonicalExact","canonicalConflict","primaryCandidates","canonicalBound")
 val v547Keys=v541Keys+setOf("recordReturned","recordInvalid","recordOtherId","recordLinkRejected","recordShared","recordAccepted","recordNoText","recordLimit","scriptOversize","scriptByteLimit","scriptTimeLimit","scriptNodeLimit","scriptParseLimit","parsedDataBlocks","parsedOtherBlocks")
 val keys=v547Keys+setOf("selectedBlocks","selectedStories","selectedCoreRecords","selectorRejected","selectorIncomplete","sourceKiB")
 fun parse(j:JSONObject?):Map<String,Int>?{
  if(j==null)return null
  val actual=j.keys().asSequence().toSet();if(actual!=keys&&actual!=legacyKeys&&actual!=v540Keys&&actual!=v541Keys&&actual!=v547Keys)return null
  val out=actual.associateWith{k->val n=j.opt(k);if(n !is Int||n !in 0..10000)return null;n}
  if(out.getValue("readerStage")>6||out.getValue("readerErrors")>1||out.getValue("budgetLimited")>1)return null
  if(listOf("canonicalExact","canonicalBound","recordLimit","scriptByteLimit","scriptTimeLimit","scriptNodeLimit","scriptParseLimit","selectorIncomplete").any{it in out&&out.getValue(it)>1})return null
  if("sourceKiB" in out&&out.getValue("sourceKiB")>4096)return null
  return out
 }
 fun report(e:Map<String,Int>)=if(e.isEmpty())"" else "\nOstatnia zwalidowana odpowiedź czytnika (liczniki, nie posty):"+(if("selectedBlocks" in e)"\nOdczyt celowany: bloki ${e["selectedBlocks"]} • struktury posta ${e["selectedStories"]} • rekordy z selekcji ${e["selectedCoreRecords"]} • odrzucone konteksty ${e["selectorRejected"]} • niepełny ${e["selectorIncomplete"]} • źródło (×1024 znaków) ${e["sourceKiB"]}." else "")+(if("recordReturned" in e)"\nParser: bloki danych ${e["parsedDataBlocks"]} • pozostałe ${e["parsedOtherBlocks"]} • zwrócone rekordy ${e["recordReturned"]} • przyjęte ${e["recordAccepted"]} (bez tekstu ${e["recordNoText"]}). Odrzucone: format ${e["recordInvalid"]} • inne ID ${e["recordOtherId"]} • permalink ${e["recordLinkRejected"]} • cytat/udostępnienie ${e["recordShared"]}.\nOgraniczenia: duże bloki ${e["scriptOversize"]} • bajty ${e["scriptByteLimit"]} • czas ${e["scriptTimeLimit"]} • liczba skryptów ${e["scriptNodeLimit"]} • parsowania ${e["scriptParseLimit"]} • rekordy ${e["recordLimit"]}." else "")+"\narticle ${e["articleNodes"]} • powiązane ${e["boundCards"]} • zagnieżdżone ${e["nestedCards"]} • odrzucony rodzic ${e["foreignParents"]} • bloki treści ${e["messageNodes"]}.\nSkrypty: znalezione ${e["scriptNodes"]} • zgodne ${e["scriptMatched"]} • parsowane ${e["scriptParsed"]} • pominięte ${e["scriptSkipped"]} • limit pracy ${e["budgetLimited"]}. Etap ${e["readerStage"]}/6 • wyjątek ${e["readerErrors"]}."+(if("hrefExact" in e)"\nPowiązanie kart: href ${e["hrefExact"]} • interaktywny adres ${e["attrExact"]} • bez adresu ${e["identityMissing"]} • inna grupa ${e["foreignGroup"]} • inny post ${e["foreignPost"]} • link komentarza/treści ${e["commentIdentity"]} • wykluczone ${e["excludedCards"]}." else "")+(if("canonicalSeen" in e)"\nDowód dokumentu: metadane ${e["canonicalSeen"]} • zgodne ${e["canonicalExact"]} • sprzeczne ${e["canonicalConflict"]} • główne karty ${e["primaryCandidates"]} • powiązanie kanoniczne ${e["canonicalBound"]}. Odrzucone linki: komentarz/hash ${e["rejectQuery"]} • obszar treści/komentarza ${e["rejectRegion"]}." else "")
}
data class ReviewPostReply(val safe:Boolean,val row:DesktopRow?,val bound:Boolean,val textRead:Boolean,val reason:String="DONE",val evidence:Map<String,Int> = emptyMap())
object ReviewDataProtocol{
    fun row(row:DesktopRow)=JSONObject().put("postId",row.postId).put("permalink",row.permalink).put("layer",row.layer).put("price",row.price?:JSONObject.NULL).put("priceSource",row.priceSource).put("area",row.area?:JSONObject.NULL).put("rooms",row.rooms?:JSONObject.NULL).put("district",row.district?:JSONObject.NULL).put("neighborhood",row.neighborhood?:JSONObject.NULL).put("street",row.street?:JSONObject.NULL).put("intent",row.intent).put("usable",row.usable).put("photos",row.photos).put("qualification",row.qualification)
    fun parse(j:JSONObject?,nonce:String,id:String,group:String):ReviewPostReply?=runCatching{
        if(j==null)return null
        val keys=j.keys().asSequence().toSet();val required=setOf("type","nonce","status","reason","rows","stats","bound","textRead")
        if((keys!=required&&keys!=required+"evidence")||j.optString("type")!="reviewPostResult"||j.optString("nonce")!=nonce)return null
        val evidence=if(j.has("evidence"))ReviewEvidence.parse(j.getJSONObject("evidence"))?:return null else emptyMap()
        val bound=j.opt("bound");val text=j.opt("textRead");if(bound !is Int||text !is Int||bound !in 0..1||text !in 0..bound)return null
        val common=JSONObject(j.toString());common.remove("bound");common.remove("textRead");common.remove("evidence");common.put("type","desktopPreviewResult")
        val parsed=DesktopProtocol.parse(common,nonce,group)?:return null
        if(parsed.status!="OK")return ReviewPostReply(false,null,false,false,parsed.reason,evidence)
        if(parsed.rows.size!=1||parsed.rows.single().postId!=id)return null
        ReviewPostReply(true,parsed.rows.single(),bound==1,text==1,parsed.reason,evidence)
    }.getOrNull()
}

data class ReviewDataSummary(val reason:String,val selected:Int,val opened:Int,val bound:Int,val textRead:Int,val enriched:Int,val unchanged:Int,val unresolved:Int,val filtered:Int,val evidence:Map<String,Int> = emptyMap(),val batchSessions:Int=0,val batchSessionsClosed:Int=0){
    fun encode()=JSONObject().put("reason",reason).put("selected",selected).put("opened",opened).put("bound",bound).put("textRead",textRead).put("enriched",enriched).put("unchanged",unchanged).put("unresolved",unresolved).put("filtered",filtered).apply{if(evidence.isNotEmpty())put("evidence",JSONObject(evidence));if(batchSessions>0||batchSessionsClosed>0){put("batchSessions",batchSessions);put("batchSessionsClosed",batchSessionsClosed)}}.toString()
    fun stopped(code:String)=copy(reason=if(code in setOf("PAUSED","CANCELLED","ERROR","SESSION_CLOSED","ENGINE_KILLED","ENGINE_CRASHED","ORIGINAL_ENGINE_KILLED","ORIGINAL_ENGINE_CRASHED","WORKER_ENGINE_KILLED","WORKER_ENGINE_CRASHED","DEADLINE"))code else "INTERRUPTED")
    fun explanation()=when(reason){
        "DONE"->"Zakończono kolejkę."
        "NAVIGATION","CONTEXT"->"Zatrzymano: adres lub kontekst posta nie przeszedł weryfikacji."
        "LOCATION_TIMEOUT"->"Zatrzymano: nie potwierdzono zakończenia nawigacji do dokładnego posta."
        "PORT_TIMEOUT"->"Zatrzymano: nie połączono nowego portu rozszerzenia dla tego dokładnego posta."
        "FOCUS_TIMEOUT"->"Zatrzymano: strona posta nie uzyskała fokusu widocznej karty."
        "DOM_TIMEOUT"->"Zatrzymano: rozszerzenie nie potwierdziło gotowości DOM posta."
        "PAGE_TIMEOUT","DEADLINE"->"Zatrzymano: upłynął limit czasu otwarcia posta lub kolejki."
        "LOAD_ERROR"->"Zatrzymano: błąd ładowania strony posta."
        "NO_OWN_POST"->"Zatrzymano po dwóch stronach bez powiązania z dokładnym postem. Nie otwierano dalszych stron; to nie dowód braku ofert."
        "REPLY_TIMEOUT"->"Zatrzymano: czytnik nie odpowiedział w limicie czasu."
        "REPLY_INVALID"->"Zatrzymano: odpowiedź czytnika nie spełniła ścisłego formatu."
        "READER_ERROR"->"Zatrzymano: czytnik zgłosił wyjątek; bez treści wyjątku i bez danych posta."
        "PROTOCOL","PORT_LOST"->"Zatrzymano: brak poprawnej odpowiedzi rozszerzenia lub utrata połączenia."
        "VERIFICATION_OR_LOGIN"->"Zatrzymano: logowanie lub weryfikacja Facebooka."
        "PAUSED","PAUSED_OR_CONTEXT"->"Zatrzymano: aplikacja utraciła aktywny widok lub poprawny kontekst."
        "CANCELLED"->"Przerwano przyciskiem operatora."
        "ORIGINAL_ENGINE_KILLED","ORIGINAL_ENGINE_CRASHED"->"Zgłoszenie z pierwotnej sesji grupy. Sesje mogą współdzielić proces; raport nie ustala przyczyny zamknięcia."
        "WORKER_ENGINE_KILLED","WORKER_ENGINE_CRASHED"->"Zgłoszenie z sesji roboczej posta. Sesje mogą współdzielić proces; raport nie ustala przyczyny zamknięcia."
        "ENGINE_KILLED"->"Gecko zgłosił zamknięcie procesu strony; raport nie ustala przyczyny zamknięcia."
        "ENGINE_CRASHED"->"Gecko zgłosił awarię procesu strony."
        "SESSION_CLOSED","ENGINE_LOST","CLOSED"->"Zatrzymano: zamknięcie lub utrata sesji."
        "ERROR"->"Zatrzymano: nieoczekiwany błąd aplikacji."
        else->"Próba nie ma potwierdzonego zakończenia."
    }
    fun report()="UZUPEŁNIANIE 0.5.59 • tylko lokalnie • $reason\n${explanation()}${if(reason!="DONE"&&reason!="NO_OWN_POST") " Podgląd wyczyszczono ochronnie; nie oznacza to znalezienia zera ofert." else ""}\nWybrano $selected • otwarto $opened • potwierdzono w DOM/danych strony $bound • odczytano tekst $textRead\nUzupełniono $enriched • bez nowych pól $unchanged • brak potwierdzonego odczytu $unresolved • poza filtrem $filtered${if(batchSessions>0) "\nSesje robocze otwarte $batchSessions • zamknięte $batchSessionsClosed." else ""}\nBrak odczytu nie dowodzi braku danych w poście. Tylko dokładne ID tej grupy; pola heurystyczne. Bez odczytu odpowiedzi sieciowych, uploadu i kolektora. OCR wymaga osobnej zgody i ma osobny raport. Pauza usuwa dane."+ReviewEvidence.report(evidence)
    companion object{
        fun decode(raw:String?):ReviewDataSummary?=runCatching{
            if(raw==null||raw.length>4096)return null
            val j=JSONObject(raw);val keys=setOf("reason","selected","opened","bound","textRead","enriched","unchanged","unresolved","filtered")
            val actual=j.keys().asSequence().toSet();val batchKeys=setOf("batchSessions","batchSessionsClosed")
            if(actual!=keys&&actual!=keys+"evidence"&&actual!=keys+batchKeys&&actual!=keys+batchKeys+"evidence")return null
            val batchSessions=if(j.has("batchSessions")){val n=j.opt("batchSessions");if(n !is Int||n !in 1..20)return null;n}else 0
            val batchClosed=if(j.has("batchSessionsClosed")){val n=j.opt("batchSessionsClosed");if(n !is Int||n !in 0..batchSessions)return null;n}else 0
            val evidence=if(j.has("evidence"))ReviewEvidence.parse(j.getJSONObject("evidence"))?:return null else emptyMap()
            if(j.optString("reason") !in setOf("DONE","NO_CONSENT_OR_INPUT","INPUT","DEADLINE","NAVIGATION","CONTEXT","PAUSED_OR_CONTEXT","PORT_LOST","LOAD_ERROR","VERIFICATION_OR_LOGIN","ENGINE_LOST","ENGINE_KILLED","ENGINE_CRASHED","ORIGINAL_ENGINE_KILLED","ORIGINAL_ENGINE_CRASHED","WORKER_ENGINE_KILLED","WORKER_ENGINE_CRASHED","NO_OWN_POST","REPLY_TIMEOUT","REPLY_INVALID","READER_ERROR","PAGE_TIMEOUT","LOCATION_TIMEOUT","PORT_TIMEOUT","FOCUS_TIMEOUT","DOM_TIMEOUT","PROTOCOL","CLOSED","INTERRUPTED","PAUSED","CANCELLED","ERROR","SESSION_CLOSED"))return null
            val counts=(keys-"reason").associateWith{k->val v=j.opt(k);if(v !is Int||v !in 0..20)return null;v}
            if(counts.getValue("opened")>counts.getValue("selected")||counts.getValue("bound")>counts.getValue("opened")||counts.getValue("textRead")>counts.getValue("bound"))return null
            if(batchSessions>counts.getValue("selected"))return null
            ReviewDataSummary(j.getString("reason"),counts.getValue("selected"),counts.getValue("opened"),counts.getValue("bound"),counts.getValue("textRead"),counts.getValue("enriched"),counts.getValue("unchanged"),counts.getValue("unresolved"),counts.getValue("filtered"),evidence,batchSessions,batchClosed)
        }.getOrNull()
        fun fields(r:DesktopRow)=listOf(r.price,r.area,r.rooms).count{it!=null}+if(listOf(r.district,r.neighborhood,r.street).any{it!=null})1 else 0}
}
