package pl.jakubokruszek.flipwatcher.geckopoc

import java.net.URI

/** Accept Facebook's host canonicalization, but never a different group or login challenge. */
object BackgroundNavigationPolicy {
    fun rejection(raw:String,group:String,fixtureOrigin:String?=null):String?=runCatching {
        val u=URI(raw)
        if(u.rawUserInfo!=null||u.rawFragment!=null||raw.length>4096)return "GROUP_CONTEXT_REJECTED"
        if(fixtureOrigin!=null){
            val origin=URI(fixtureOrigin)
            if(u.scheme!="http"||u.host!="127.0.0.1"||u.rawAuthority!=origin.rawAuthority)return "GROUP_CONTEXT_REJECTED"
        }else if(u.scheme!="https"||u.port!=-1||u.host !in setOf("facebook.com","www.facebook.com","m.facebook.com"))return "GROUP_CONTEXT_REJECTED"
        val path=u.rawPath.orEmpty()
        when {
            Regex("checkpoint|two_step_verification",RegexOption.IGNORE_CASE).containsMatchIn(path)->"CHECKPOINT"
            path.contains("captcha",true)->"CAPTCHA"
            Regex("^/(login|recover)",RegexOption.IGNORE_CASE).containsMatchIn(path)->"LOGIN_REQUIRED"
            path.trimEnd('/')!="/groups/$group"->"GROUP_CONTEXT_REJECTED"
            else->null
        }
    }.getOrElse{"GROUP_CONTEXT_REJECTED"}
}
