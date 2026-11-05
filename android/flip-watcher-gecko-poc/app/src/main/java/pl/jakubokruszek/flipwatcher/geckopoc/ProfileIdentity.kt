package pl.jakubokruszek.flipwatcher.geckopoc

import java.net.URI
/** Explicit profile source identity. Group grants never accept opaque profile post IDs. */
object ProfileIdentity {
    fun postId(id:String,profile:Boolean=false)=Regex("[0-9]{5,30}").matches(id)||(profile&&Regex("pfbid[A-Za-z0-9]{10,180}").matches(id))
    fun candidate(raw:String,source:WatcherGroup,fixtureOrigin:String?=null):Boolean=runCatching {
        require(source.type=="PROFILE")
        val u=URI(raw);if(u.rawUserInfo!=null||u.rawFragment!=null)return false
        if(fixtureOrigin!=null){val root=URI(fixtureOrigin);if(u.scheme!="http"||u.host!="127.0.0.1"||u.rawAuthority!=root.rawAuthority)return false}
        else if(u.scheme!="https"||u.port!=-1||u.host !in setOf("www.facebook.com","facebook.com","m.facebook.com"))return false
        val path=u.rawPath.orEmpty().trimEnd('/')
        if(path=="/profile.php")return u.rawQuery=="id="+source.id
        if(Regex("^/people/[^/]+/"+Regex.escape(source.id)+"$").matches(path))return u.rawQuery==null
        // A Facebook redirect to a vanity route is only a candidate; the extension
        // must independently prove the numeric owner in HEAD before reading pixels.
        Regex("^/[A-Za-z0-9_.-]{1,100}$").matches(path)&&path.drop(1) !in setOf("groups","login","checkpoint","recover","watch","marketplace","stories","notifications","photo","reel","home.php","settings")&&u.rawQuery==null
    }.getOrDefault(false)
}
