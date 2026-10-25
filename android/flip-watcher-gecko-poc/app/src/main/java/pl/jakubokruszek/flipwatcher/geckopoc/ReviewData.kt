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
        if(raw=="about:blank"&&!seenRequest)return tick()
        if(!tick()||!seenRequest||expectedId==null||!matches(raw,group,expectedId!!,fixture)){stop("CONTEXT");return false}
        currentUrl=raw;return true
    }
    companion object{
        fun matches(raw:String?,group:String,id:String,fixture:Boolean=false):Boolean=runCatching{
            val u=URI(raw?:return false)
            Regex("^[A-Za-z0-9._-]{1,100}$").matches(group)&&Regex("^[0-9]{5,30}$").matches(id)&&u.rawUserInfo==null&&u.rawQuery==null&&u.rawFragment==null&&
            ((u.scheme=="https"&&u.port==-1&&u.host?.lowercase() in setOf("facebook.com","www.facebook.com","m.facebook.com"))||(fixture&&u.scheme=="http"&&u.host=="127.0.0.1"&&u.port in 1..65535))&&
            u.rawPath in setOf("/groups/$group/posts/$id","/groups/$group/posts/$id/","/groups/$group/permalink/$id","/groups/$group/permalink/$id/")
        }.getOrDefault(false)
        fun queue(rows:List<DesktopRow>,group:String=PocPolicy.APPROVED_GROUP_ID)=rows.take(20).filter{DesktopPresentation.reviewable(it)&&it.permalink=="https://www.facebook.com/groups/$group/posts/${it.postId}/"&&matches(it.permalink,group,it.postId)}.distinctBy{it.postId}
    }
}

data class ReviewPostReply(val safe:Boolean,val row:DesktopRow?,val bound:Boolean,val textRead:Boolean)
object ReviewDataProtocol{
    fun row(row:DesktopRow)=JSONObject().put("postId",row.postId).put("permalink",row.permalink).put("layer",row.layer).put("price",row.price?:JSONObject.NULL).put("priceSource",row.priceSource).put("area",row.area?:JSONObject.NULL).put("rooms",row.rooms?:JSONObject.NULL).put("district",row.district?:JSONObject.NULL).put("neighborhood",row.neighborhood?:JSONObject.NULL).put("street",row.street?:JSONObject.NULL).put("intent",row.intent).put("usable",row.usable).put("photos",row.photos).put("qualification",row.qualification)
    fun parse(j:JSONObject?,nonce:String,id:String,group:String):ReviewPostReply?=runCatching{
        if(j==null||j.keys().asSequence().toSet()!=setOf("type","nonce","status","reason","rows","stats","bound","textRead")||j.optString("type")!="reviewPostResult"||j.optString("nonce")!=nonce)return null
        val bound=j.opt("bound");val text=j.opt("textRead");if(bound !is Int||text !is Int||bound !in 0..1||text !in 0..bound)return null
        val common=JSONObject(j.toString());common.remove("bound");common.remove("textRead");common.put("type","desktopPreviewResult")
        val parsed=DesktopProtocol.parse(common,nonce,group)?:return null
        if(parsed.status!="OK")return ReviewPostReply(false,null,false,false)
        if(parsed.rows.size!=1||parsed.rows.single().postId!=id)return null
        ReviewPostReply(true,parsed.rows.single(),bound==1,text==1)
    }.getOrNull()
}

data class ReviewDataSummary(val reason:String,val selected:Int,val opened:Int,val bound:Int,val textRead:Int,val enriched:Int,val unchanged:Int,val unresolved:Int,val filtered:Int){
    fun encode()=JSONObject().put("reason",reason).put("selected",selected).put("opened",opened).put("bound",bound).put("textRead",textRead).put("enriched",enriched).put("unchanged",unchanged).put("unresolved",unresolved).put("filtered",filtered).toString()
    fun report()="UZUPEŁNIANIE 0.5.34 • tylko lokalnie • $reason\nWybrano $selected • otwarto $opened • potwierdzono w DOM/danych strony $bound • odczytano tekst $textRead\nUzupełniono $enriched • bez nowych pól $unchanged • brak potwierdzonego odczytu $unresolved • poza filtrem $filtered\nBrak odczytu nie dowodzi braku danych w poście. Tylko dokładne ID tej grupy; pola heurystyczne. Bez odczytu odpowiedzi sieciowych, OCR, uploadu i kolektora. Pauza usuwa dane."
    companion object{
        fun decode(raw:String?):ReviewDataSummary?=runCatching{
            if(raw==null||raw.length>2000)return null
            val j=JSONObject(raw);val keys=setOf("reason","selected","opened","bound","textRead","enriched","unchanged","unresolved","filtered")
            if(j.keys().asSequence().toSet()!=keys||j.optString("reason") !in setOf("DONE","NO_CONSENT_OR_INPUT","INPUT","DEADLINE","NAVIGATION","CONTEXT","PAUSED_OR_CONTEXT","PORT_LOST","LOAD_ERROR","VERIFICATION_OR_LOGIN","ENGINE_LOST","PAGE_TIMEOUT","PROTOCOL","CLOSED"))return null
            val counts=(keys-"reason").associateWith{k->val v=j.opt(k);if(v !is Int||v !in 0..20)return null;v}
            if(counts.getValue("opened")>counts.getValue("selected")||counts.getValue("bound")>counts.getValue("opened")||counts.getValue("textRead")>counts.getValue("bound"))return null
            ReviewDataSummary(j.getString("reason"),counts.getValue("selected"),counts.getValue("opened"),counts.getValue("bound"),counts.getValue("textRead"),counts.getValue("enriched"),counts.getValue("unchanged"),counts.getValue("unresolved"),counts.getValue("filtered"))
        }.getOrNull()
        fun fields(r:DesktopRow)=listOf(r.price,r.area,r.rooms).count{it!=null}+if(listOf(r.district,r.neighborhood,r.street).any{it!=null})1 else 0}
}
