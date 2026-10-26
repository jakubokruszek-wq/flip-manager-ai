package pl.jakubokruszek.flipwatcher.geckopoc

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.mozilla.geckoview.AllowOrDeny
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoSessionSettings
import org.mozilla.geckoview.GeckoView
import org.mozilla.geckoview.WebRequestError

/** Foreground temporary session shares the existing runtime, not a background/screen-off browser. */
object ReviewDataRunner{
    data class Outcome(val summary:ReviewDataSummary,val rows:List<DesktopRow>)
    suspend fun run(view:GeckoView,original:GeckoSession,rows:List<DesktopRow>,consent:Boolean,alive:()->Boolean,progress:(Int,Int)->Unit={_,_->},restoreActive:()->Boolean=alive,fixtureOrigin:String?=null,observe:(String)->Unit={},snapshot:(ReviewDataSummary)->Unit={},onBoundPost:suspend(CollectorChannel,DesktopRow,String,()->Boolean)->Unit={_,_,_,_->}):Outcome=withContext(Dispatchers.Main){
        val fixture=fixtureOrigin!=null;val group=if(fixture)FIXTURE_GROUP_ID else PocPolicy.APPROVED_GROUP_ID
        val queue=ReviewDataGate.queue(rows,group);var opened=0;var bound=0;var text=0;var enriched=0;var unchanged=0;var unresolved=0;var filtered=0
        fun summary(reason:String)=ReviewDataSummary(reason,queue.size,opened,bound,text,enriched,unchanged,unresolved,filtered)
        fun outcome(reason:String,result:List<DesktopRow> = emptyList()):Outcome{observe("END_"+reason);val value=summary(reason);snapshot(value);return Outcome(value,result)}
        if(!consent||queue.isEmpty()||rows.size>20||rows.map{it.postId}.distinct().size!=rows.size||!alive())return@withContext outcome("NO_CONSENT_OR_INPUT")
        val gate=ReviewDataGate(group,fixture){android.os.SystemClock.elapsedRealtime()}
        val settings=GeckoSessionSettings.Builder().userAgentMode(GeckoSessionSettings.USER_AGENT_MODE_DESKTOP).viewportMode(GeckoSessionSettings.VIEWPORT_MODE_DESKTOP).build()
        val browser=GeckoSession(settings);var navigating=true;var openedSession=false;var attached=false;var detached=false
        val channel=CollectorChannel(browser,fixtureMode=fixture,onPageDisconnect={if(!navigating&&gate.active)gate.stop("PORT_LOST")})
        fun live():Boolean{if(!alive()||attached&&(!view.isShown||!view.hasWindowFocus()))gate.stop("PAUSED_OR_CONTEXT");return gate.tick()}
        browser.navigationDelegate=object:GeckoSession.NavigationDelegate{
            override fun onLoadRequest(s:GeckoSession,q:GeckoSession.NavigationDelegate.LoadRequest)=GeckoResult.fromValue(if(gate.request(q.uri,q.target==GeckoSession.NavigationDelegate.TARGET_WINDOW_NEW,q.hasUserGesture))AllowOrDeny.ALLOW else AllowOrDeny.DENY)
            override fun onLocationChange(s:GeckoSession,u:String?,p:MutableList<GeckoSession.PermissionDelegate.ContentPermission>,gesture:Boolean){if(gesture)gate.stop("NAVIGATION") else {observe(if(u==null)"LOCATION_NULL" else if(u=="about:blank")"LOCATION_BLANK" else if(ReviewDataGate.matches(u,group,gate.expectedId.orEmpty(),fixture))"LOCATION_EXACT" else "LOCATION_FOREIGN");val accepted=gate.location(u);observe(if(accepted)"LOCATION_OK" else "LOCATION_STOP")}}
            override fun onLoadError(s:GeckoSession,u:String?,e:WebRequestError):GeckoResult<String>?{gate.stop("LOAD_ERROR");return null}
        }
        browser.progressDelegate=object:GeckoSession.ProgressDelegate{
            override fun onPageStop(s:GeckoSession,success:Boolean){if(!success)gate.stop("LOAD_ERROR")}
        }
        browser.contentDelegate=object:GeckoSession.ContentDelegate{
            override fun onTitleChange(s:GeckoSession,t:String?){if(Regex("log in|logowanie|captcha|checkpoint|security check|potwierdź.*tożsamość",RegexOption.IGNORE_CASE).containsMatchIn(t.orEmpty()))gate.stop("VERIFICATION_OR_LOGIN")}
            override fun onCrash(s:GeckoSession){gate.stop("ENGINE_LOST")}
            override fun onKill(s:GeckoSession){gate.stop("ENGINE_LOST")}
        }
        val merged=rows.associateByTo(linkedMapOf()){it.postId}
        try{
            channel.attach(GeckoHost.collectorExtension(view.context));browser.open(GeckoHost.runtime(view.context));openedSession=true
            view.releaseSession();detached=true;original.setActive(false);view.setSession(browser);attached=true;browser.setActive(true);browser.setFocused(true);view.requestFocus()
            for((index,previous) in queue.withIndex()){
                if(!live())return@withContext outcome(gate.reason)
                val target=if(fixture)fixtureOrigin!!.trimEnd('/')+"/groups/$group/posts/${previous.postId}/" else previous.permalink
                if(!ReviewDataGate.matches(target,group,previous.postId,fixture)){gate.stop("INPUT");return@withContext outcome(gate.reason)}
                navigating=true;gate.expect(previous.postId);val generation=channel.connectionGeneration
                snapshot(summary("INTERRUPTED"));progress(index+1,queue.size);if(!live())return@withContext outcome(gate.reason);opened++;val deadline=android.os.SystemClock.elapsedRealtime()+20_000
                // Native loadUri need not emit onLoadRequest; authorize this exact native request first.
                if(!gate.request(target))return@withContext outcome(gate.reason)
                snapshot(summary("INTERRUPTED"));observe("NATIVE_REQUEST_OK");browser.loadUri(target)
                var documentReady=false
                // A Facebook page may keep loading media after its own DOM and trusted port are ready.
                // Never substitute a load percentage for exact location/port/focus/DOM proof.
                while(live()&&android.os.SystemClock.elapsedRealtime()<deadline){
                    if(gate.currentUrl!=null&&channel.isConnected&&channel.connectionGeneration>generation&&ReviewDataGate.matches(channel.connectedUrl,group,previous.postId,fixture)&&view.hasWindowFocus()&&view.hasFocus()){
                        val probe=channel.probe(1_000)
                        if(probe?.readyState in setOf("interactive","complete")){documentReady=true;break}
                    }
                    delay(100)
                }
                if(!live())return@withContext outcome(gate.reason)
                if(!documentReady){gate.stop("PAGE_TIMEOUT");return@withContext outcome(gate.reason)}
                browser.setFocused(true);view.requestFocus();navigating=false;val portGeneration=channel.connectionGeneration;var reply:ReviewPostReply?=null
                for(attempt in 0..2){
                    delay(500);if(!live()||channel.connectionGeneration!=portGeneration)return@withContext outcome(if(gate.active)"PORT_LOST" else gate.reason)
                    val current=gate.currentUrl?:return@withContext outcome("CONTEXT")
                    reply=channel.reviewPost(previous,current,true,group,observe)
                    if(!live()||channel.connectionGeneration!=portGeneration)return@withContext outcome(if(gate.active)"PORT_LOST" else gate.reason)
                    if(reply==null)return@withContext outcome("PROTOCOL")
                    if(reply.safe!=true)return@withContext outcome("CONTEXT")
                    if(reply.textRead)break
                }
                val result=reply?:return@withContext outcome("PROTOCOL");val updated=result.row?:return@withContext outcome("PROTOCOL")
                if(result.bound){bound++;onBoundPost(channel,updated,gate.currentUrl?:return@withContext outcome("CONTEXT"),{live()&&channel.connectionGeneration==portGeneration});if(!live()||channel.connectionGeneration!=portGeneration)return@withContext outcome(if(gate.active)"PORT_LOST" else gate.reason)};if(result.textRead)text++ else unresolved++
                if(!DesktopPresentation.reviewable(updated)&&!DesktopSummary.eligible(updated))filtered++
                else if(ReviewDataSummary.fields(updated)>ReviewDataSummary.fields(previous)||DesktopSummary.eligible(updated)&&!DesktopSummary.eligible(previous))enriched++
                else if(result.textRead)unchanged++
                merged[previous.postId]=updated;snapshot(summary("INTERRUPTED"))
            }
            if(!live())return@withContext outcome(gate.reason)
            outcome("DONE",merged.values.toList())
        }finally{
            gate.stop("CLOSED");navigating=true;channel.close();runCatching{browser.stop()}
            if(attached)runCatching{view.releaseSession()};if(openedSession)runCatching{browser.close()}
            if(detached)runCatching{view.setSession(original);original.setActive(restoreActive());if(restoreActive()){original.setFocused(true);view.requestFocus()}}
        }
    }
}
