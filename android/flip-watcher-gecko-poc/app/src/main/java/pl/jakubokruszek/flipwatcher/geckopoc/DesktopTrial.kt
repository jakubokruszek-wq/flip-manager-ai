package pl.jakubokruszek.flipwatcher.geckopoc

import java.net.URI

/** One newly consented reload of an approved root, desktop settings, no collector or upload. */
class DesktopTrial(private val target: String, private val now: () -> Long, private val fixture: Boolean = false, private val groupId:String=PocPolicy.APPROVED_GROUP_ID, private val allowRootQuery:Boolean=false) {
    enum class Phase { ARMING, NAVIGATION, LOCATION, PORT, FRESHNESS, PAGE, FOCUS, READING }
    var phase=Phase.ARMING; private set
    var active=false; private set
    var reason="NOT_STARTED"; private set
    var requests=0; private set
    var requested: String?=null; private set
    var located=false; private set
    private var started=false
    private var armed=false
    private var deadline=0L
    private fun root(raw:String):Boolean = runCatching {
        val u=URI(raw);val group=if(fixture)FIXTURE_GROUP_ID else groupId
        u.rawUserInfo==null && u.rawFragment==null && (fixture || allowRootQuery || u.rawQuery==null) && u.rawPath.trimEnd('/')=="/groups/$group" &&
            (if(fixture) u.scheme=="http" && u.host=="127.0.0.1" && u.rawAuthority==URI(target).rawAuthority
             else u.scheme=="https" && u.port==-1 && u.host in setOf("facebook.com","www.facebook.com","m.facebook.com"))
    }.getOrDefault(false)
    fun begin(consent:Boolean):Boolean {
        if(started)return false;started=true
        if(!consent||!root(target)){reason="NO_CONSENT_OR_CONTEXT";return false}
        active=true;deadline=now()+60_000;return true
    }
    val remainingMs:Long get()=(deadline-now()).coerceAtLeast(0)
    fun tick():Boolean {if(active && now()>=deadline)stop("DEADLINE_${phase.name}");return active}
    fun waitFor(value:Phase){if(active)phase=value}
    fun armed():Boolean {if(!tick())return false;armed=true;phase=Phase.NAVIGATION;return true}
    fun request(raw:String,redirect:Boolean,newWindow:Boolean,gesture:Boolean):Boolean {
        if(!tick())return false
        if(!armed||newWindow||gesture||!root(raw)||requests>=4||(if(requests==0)raw!=target else !redirect)){stop("NAVIGATION");return false}
        requests++;requested=raw;located=false;phase=Phase.LOCATION;return true
    }
    fun location(raw:String?):Boolean {
        if(!tick())return false
        if(requests==0&&raw==target)return true // queued source notification; never a proof
        if(raw==null||raw!=requested||!root(raw)){stop("NAVIGATION");return false}
        located=true;return true
    }
    fun complete():Boolean {if(!tick()||!armed||!located||requests==0||phase!=Phase.READING)return false;stop("DONE");return true}
    fun stop(value:String){if(!active)return;active=false;reason=if(value in reasons)value else "PROTOCOL";requested=null;located=false}
    companion object {
        val reasons=setOf("NOTICE_BLOCKED","DONE","EMPTY","PAUSED","NAVIGATION","LOAD_ERROR","PORT_LOST","PROTOCOL","DESKTOP_NOT_APPLIED","ARM_STOP","ARM_BUSY","ARM_UNSUPPORTED","NO_CONSENT_OR_CONTEXT","CONTEXT","ERROR","CANCELLED")+Phase.values().map{"DEADLINE_${it.name}"}
    }
}
