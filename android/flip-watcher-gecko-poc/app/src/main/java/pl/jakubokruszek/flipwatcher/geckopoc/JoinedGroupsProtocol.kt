package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

data class JoinedGroup(val url:String,val name:String?)
data class JoinedGroupsResult(val groups:List<JoinedGroup>,val stats:Map<String,Int>){
    fun body()=JSONObject().put("version",1).put("pageUrl",JoinedGroupsProtocol.URL).put("groups",JSONArray(groups.map{JSONObject().put("url",it.url).put("name",it.name?:JSONObject.NULL)})).toString()
}
object JoinedGroupsProtocol {
    const val URL="https://www.facebook.com/groups/joins/"
    private val reserved=setOf("joins","feed","discover","create","notifications","your_groups")
    internal fun page(raw:String,fixtureOrigin:String?=null):Boolean=runCatching{
        val u=URI(raw)
        if(u.rawUserInfo!=null||u.rawFragment!=null||u.path.trimEnd('/')!="/groups/joins")return false
        if(fixtureOrigin!=null){val f=URI(fixtureOrigin);u.scheme=="http"&&u.host=="127.0.0.1"&&u.rawAuthority==f.rawAuthority}
        else u.scheme=="https"&&u.port==-1&&u.host in setOf("www.facebook.com","m.facebook.com","facebook.com")
    }.getOrDefault(false)
    fun parse(value:JSONObject,nonce:String):JoinedGroupsResult?=runCatching{
        require(value.keys().asSequence().toSet()==setOf("type","nonce","status","reason","groups","stats"))
        require(value.getString("type")=="joinedGroupsResult"&&value.getString("nonce")==nonce)
        if(value.optString("status")!="OK")error(value.optString("reason").takeIf{it.matches(Regex("[A-Z_]{1,60}"))}?:"DISCOVERY_PROTOCOL")
        require(value.getString("reason") in setOf("DONE","DISCOVERY_NO_GROUP_LINKS"))
        val a=value.getJSONArray("groups");require(a.length()<=200)
        val seen=mutableSetOf<String>()
        val groups=(0 until a.length()).map{i->val r=a.getJSONObject(i)
            require(r.keys().asSequence().toSet()==setOf("url","name"))
            val url=r.getString("url");val id=Regex("https://www\\.facebook\\.com/groups/([a-z0-9_.-]{1,100})/").matchEntire(url)?.groupValues?.get(1)
            require(id!=null&&id !in reserved&&seen.add(id))
            val name=if(r.isNull("name"))null else r.getString("name").also{require(it.isNotBlank()&&it==it.trim()&&it.length<=200&&!Regex("[\\p{Cc}]|https?://").containsMatchIn(it))}
            JoinedGroup(url,name)
        }
        val keys=setOf("examined","accepted","namesFound","rejected","duplicates","scrollSteps","scrollMoves","stabilized","pageVisible")
        val s=value.getJSONObject("stats");require(s.keys().asSequence().toSet()==keys)
        val stats=keys.associateWith{k->val v=s.get(k);require(v is Int&&v in 0..100000);v}
        require(stats.getValue("accepted")==groups.size&&stats.getValue("namesFound")==groups.count{it.name!=null}&&stats.getValue("scrollSteps")<=60&&stats.getValue("scrollMoves")<=stats.getValue("scrollSteps")&&stats.getValue("stabilized")<=1&&stats.getValue("pageVisible")==1)
        JoinedGroupsResult(groups,stats)
    }.getOrNull()
}
