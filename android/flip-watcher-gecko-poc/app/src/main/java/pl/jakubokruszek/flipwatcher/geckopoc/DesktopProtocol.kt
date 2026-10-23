package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject

/** Transient selected fields only. Never persisted, logged or copied with the count-only report. */
data class DesktopRow(val postId:String,val permalink:String,val layer:String,val price:Double?,val priceSource:String,val area:Double?,val rooms:Int?,val district:String?,val neighborhood:String?,val street:String?,val intent:String,val usable:Boolean,val photos:Int,val qualification:String="CLASSIFIER")
data class DesktopReply(val status:String,val reason:String,val rows:List<DesktopRow>,val stats:Map<String,Int>)
data class DesktopDocumentProof(val documentId:String,val timeOrigin:Double) {
    override fun toString()="DesktopDocumentProof(redacted)"
}
object DesktopProtocol {
    fun documentProof(message:Any?,nonce:String):DesktopDocumentProof?=runCatching {
        val j=ScanProtocol.asJson(message)?:return null
        if(j.keys().asSequence().toSet()!=setOf("type","nonce","documentId","timeOrigin")||j.opt("type")!="desktopDocumentProof"||j.opt("nonce")!=nonce)return null
        val id=j.getString("documentId");if(java.util.UUID.fromString(id).toString()!=id)return null
        val time=j.opt("timeOrigin");if(time !is Number||!time.toDouble().isFinite()||time.toDouble()<=0)return null
        DesktopDocumentProof(id,time.toDouble())
    }.getOrNull()

    val statKeys=listOf("candidates","dom","hydration","network","duplicates","rejected","ambiguous","scripts","scrollSteps","scrollMoves","requests","bytes","verified","desktop","filtered","completed","streamErrors","decodeErrors","oversize","limitSkipped","articles","mobile","scrollSeen","scrollNoRange","scrollHidden","scrollOffscreen","scrollUnbound","scrollRoot","scrollInner","scrollHit","scrollElapsedMs","scrollStalls","scrollAtEnd","scrollNoTarget","scrollTailAttempts","scrollTailMoves","pageFocused","pageVisible","scrollNativeSteps","scrollNativeMoves","photoPreviewFrames","photoPreviews","viewportHeight","visualViewportHeight","rootRemaining","viewportModule","viewportGranted","viewportReady","viewportProbeCode","nativeRequests","nativeRejected","nativeTimeout","pointMisses","mediaBindingPosts")
    private val rowKeys=setOf("postId","permalink","layer","price","priceSource","area","rooms","district","neighborhood","street","intent","usable","photos","qualification")
    val qualifications=setOf("CANDIDATE","NO_TEXT","FOREIGN_CITY","NOT_PROPERTY","INTENT","MISSING_FIELDS","CONFLICT","CLASSIFIER")
    val intents=setOf("SELL_PROPERTY","BUY_PROPERTY","RENT_OFFER","RENT_WANTED","SERVICE","OTHER","UNKNOWN")
    fun parse(message:Any?,nonce:String,group:String=PocPolicy.APPROVED_GROUP_ID):DesktopReply? = runCatching {
        val j=ScanProtocol.asJson(message)?:return null
        if(j.keys().asSequence().toSet()!=setOf("type","nonce","status","reason","rows","stats")||j.opt("type")!="desktopPreviewResult"||j.opt("nonce")!=nonce)return null
        val status=j.optString("status");val reason=j.optString("reason")
        if(status !in setOf("OK","STOP","WAIT_FRESH")||reason !in setOf("DONE","CONTEXT","ERROR","BUSY","FRESHNESS"))return null
        if((status=="OK")!=(reason=="DONE")||(status=="WAIT_FRESH")!=(reason=="FRESHNESS"))return null
        val stats=parseStats(j.getJSONObject("stats"))?:return null
        val a=j.getJSONArray("rows");if(a.length()>20||(status!="OK"&&a.length()!=0))return null
        if(status=="OK"&&stats.getValue("verified")!=1)return null
        val seen=HashSet<String>();val rows=(0 until a.length()).map {i->
            val r=a.getJSONObject(i);if(r.keys().asSequence().toSet()!=rowKeys)return null
            val id=r.getString("postId");val link=r.getString("permalink")
            if(!Regex("^[0-9]{5,30}$").matches(id)||link!="https://www.facebook.com/groups/$group/posts/$id/"||!seen.add(id))return null
            fun num(key:String,min:Double,max:Double):Double? {if(r.isNull(key))return null;val v=r.get(key);require(v is Number);val n=v.toDouble();require(n.isFinite()&&n in min..max);return n}
            fun text(key:String,max:Int):String? {if(r.isNull(key))return null;val v=r.get(key);require(v is String&&v.length in 1..max&&!Regex("https?://|[\\p{Cc}]").containsMatchIn(v));return v}
            val price=num("price",1.0,20_000_000.0);val area=num("area",1.0,9999.0);val rooms=num("rooms",1.0,20.0)
            if(rooms!=null&&rooms%1.0!=0.0)return null
            val source=r.getString("priceSource");if(source !in setOf("NONE","EXPLICIT_TOTAL","THOUSANDS_TOTAL","DERIVED_FROM_PRICE_PER_M2")||(price==null)!=(source=="NONE"))return null
            val layer=r.getString("layer");if(layer !in setOf("DOM","HYDRATION","NETWORK","MIXED"))return null
            val intent=r.getString("intent");if(intent !in intents||r.opt("usable") !is Boolean||r.opt("photos") !is Int||r.getInt("photos") !in 0..20)return null
            val district=text("district",30);if(district!=null&&district !in setOf("Bałuty","Widzew","Polesie","Śródmieście","Górna"))return null
            val qualification=r.getString("qualification");if(qualification !in qualifications)return null
            DesktopRow(id,link,layer,price,source,area,rooms?.toInt(),district,text("neighborhood",40),text("street",80),intent,r.getBoolean("usable"),r.getInt("photos"),qualification)
        }
        if(stats.getValue("candidates")!=rows.size)return null
        DesktopReply(status,reason,rows,stats)
    }.getOrNull()
    fun parseStats(j:JSONObject):Map<String,Int>? {
        if(j.keys().asSequence().toSet()!=statKeys.toSet())return null
        val result=statKeys.associateWith{key->val v=j.opt(key);if(v !is Int||v<0||v>(if(key=="bytes")4194304 else if(key=="scrollElapsedMs")30000 else 10000))return null;v}
        if(result.getValue("candidates")>20||result.getValue("verified")>1||result.getValue("desktop")>1||result.getValue("scrollSteps")>30||result.getValue("scrollMoves")>result.getValue("scrollSteps"))return null
        if(result.getValue("scrollSeen")>512||result.getValue("scrollHit")>30||result.getValue("scrollRoot")>1||result.getValue("scrollInner")>1||listOf("scrollNoRange","scrollHidden","scrollOffscreen","scrollUnbound").any{result.getValue(it)>512})return null
        if(result.getValue("scrollStalls")>result.getValue("scrollSteps")-result.getValue("scrollMoves")||result.getValue("scrollAtEnd")>512||result.getValue("scrollNoTarget")>30)return null
        if(result.getValue("scrollTailAttempts")>2||result.getValue("scrollTailAttempts")>result.getValue("scrollSteps")||result.getValue("scrollTailMoves")>result.getValue("scrollTailAttempts")||result.getValue("scrollTailMoves")>result.getValue("scrollMoves")||result.getValue("pageFocused")>1||result.getValue("pageVisible")>1)return null
        if(result.getValue("scrollNativeSteps")>result.getValue("scrollSteps")||result.getValue("scrollNativeMoves")>result.getValue("scrollNativeSteps")||result.getValue("scrollNativeMoves")>result.getValue("scrollMoves")||result.getValue("photoPreviewFrames")>20||result.getValue("photoPreviews")>60)return null
        if(listOf("viewportModule","viewportGranted","viewportReady").any{result.getValue(it)>1}||result.getValue("viewportProbeCode")>4||result.getValue("nativeRequests")>30||result.getValue("nativeRejected")+result.getValue("nativeTimeout")>result.getValue("nativeRequests")||result.getValue("mediaBindingPosts")>20||result.getValue("pointMisses")>30)return null
        return result
    }
    fun emptyStats()=statKeys.associateWith{0}
}
