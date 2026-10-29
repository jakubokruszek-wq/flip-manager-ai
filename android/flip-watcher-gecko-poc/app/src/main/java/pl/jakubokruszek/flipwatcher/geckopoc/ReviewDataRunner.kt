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

/** Foreground bounded workers; one queue grant and deadline across all batches. */
object ReviewDataRunner{
    private const val POSTS_PER_SESSION=1
    data class Outcome(val summary:ReviewDataSummary,val rows:List<DesktopRow>)
    suspend fun run(view:GeckoView,original:GeckoSession,rows:List<DesktopRow>,consent:Boolean,alive:()->Boolean,progress:(Int,Int)->Unit={_,_->},restoreActive:()->Boolean=alive,fixtureOrigin:String?=null,observe:(String)->Unit={},snapshot:(ReviewDataSummary)->Unit={},originalChannel:CollectorChannel?=null,onBoundPost:suspend(CollectorChannel,DesktopRow,String,()->Boolean)->Unit={_,_,_,_->}):Outcome=withContext(Dispatchers.Main){
        val fixture=fixtureOrigin!=null;val group=if(fixture)FIXTURE_GROUP_ID else PocPolicy.APPROVED_GROUP_ID
        val queue=ReviewDataGate.queue(rows,group);var opened=0;var bound=0;var text=0;var enriched=0;var unchanged=0;var unresolved=0;var filtered=0;var unboundStreak=0;var evidence:Map<String,Int> = emptyMap()
        var batchSessions=0;var batchSessionsClosed=0;var restorePermitted=false
        fun summary(reason:String)=ReviewDataSummary(reason,queue.size,opened,bound,text,enriched,unchanged,unresolved,filtered,evidence,batchSessions,batchSessionsClosed)
        fun outcome(reason:String,result:List<DesktopRow> = emptyList()):Outcome{restorePermitted=reason in setOf("DONE","NO_OWN_POST");observe("END_"+reason);val value=summary(reason);snapshot(value);return Outcome(value,result)}
        if(!consent||queue.isEmpty()||rows.size>20||rows.map{it.postId}.distinct().size!=rows.size||view.session!==original||!alive())return@withContext outcome("NO_CONSENT_OR_INPUT")
        val gate=ReviewDataGate(group,fixture){android.os.SystemClock.elapsedRealtime()}
        val settings=GeckoSessionSettings.Builder().userAgentMode(GeckoSessionSettings.USER_AGENT_MODE_DESKTOP).viewportMode(GeckoSessionSettings.VIEWPORT_MODE_DESKTOP).build()
        var originalDetached=false;var lastWorker:GeckoSession?=null
        val parking=originalChannel?.let{ReviewOriginalParking(original,it,it.connectedUrl?:return@withContext outcome("CONTEXT"))}
        val merged=rows.associateByTo(linkedMapOf()){it.postId}
        fun active():Boolean{if(!alive()||!view.isShown||!view.hasWindowFocus())gate.stop("PAUSED_OR_CONTEXT");return gate.tick()}
        suspend fun runBatch(batch:List<IndexedValue<DesktopRow>>):String?{
            if(!active())return gate.reason
            // Never navigate a live detail worker to another post: cancelling residual media
            // can emit onPageStop(false) for the previous document without an address.
            check(batch.size==1)
            val epoch=gate.beginSession();if(epoch==0)return gate.reason
            val browser=GeckoSession(settings);lastWorker=browser;var navigating=true;var openedSession=false
            val channel=CollectorChannel(browser,fixtureMode=fixture,onPageDisconnect={if(gate.acceptsSession(epoch)&&!navigating)gate.stop("PORT_LOST")})
            fun live()=active()&&gate.acceptsSession(epoch)
            browser.navigationDelegate=object:GeckoSession.NavigationDelegate{
                override fun onLoadRequest(s:GeckoSession,q:GeckoSession.NavigationDelegate.LoadRequest)=GeckoResult.fromValue(if(gate.acceptsSession(epoch)&&gate.request(q.uri,q.target==GeckoSession.NavigationDelegate.TARGET_WINDOW_NEW,q.hasUserGesture))AllowOrDeny.ALLOW else AllowOrDeny.DENY)
                override fun onLocationChange(s:GeckoSession,u:String?,p:MutableList<GeckoSession.PermissionDelegate.ContentPermission>,gesture:Boolean){
                    if(!gate.acceptsSession(epoch))return
                    if(gesture)gate.stop("NAVIGATION") else {observe(if(u==null)"LOCATION_NULL" else if(u=="about:blank")"LOCATION_BLANK" else if(ReviewDataGate.matches(u,group,gate.expectedId.orEmpty(),fixture))"LOCATION_EXACT" else "LOCATION_FOREIGN");val accepted=gate.location(u);observe(if(accepted)"LOCATION_OK" else "LOCATION_STOP")}
                }
                override fun onLoadError(s:GeckoSession,u:String?,e:WebRequestError):GeckoResult<String>?{if(gate.acceptsSession(epoch))gate.stop("LOAD_ERROR");return null}
            }
            browser.progressDelegate=object:GeckoSession.ProgressDelegate{
                override fun onPageStop(s:GeckoSession,success:Boolean){if(gate.acceptsSession(epoch)&&!success)gate.stop("LOAD_ERROR")}
            }
            browser.contentDelegate=object:GeckoSession.ContentDelegate{
                override fun onTitleChange(s:GeckoSession,t:String?){if(gate.acceptsSession(epoch)&&Regex("log in|logowanie|captcha|checkpoint|security check|potwierdź.*tożsamość",RegexOption.IGNORE_CASE).containsMatchIn(t.orEmpty()))gate.stop("VERIFICATION_OR_LOGIN")}
                override fun onCrash(s:GeckoSession){if(gate.acceptsSession(epoch))gate.stop("WORKER_ENGINE_CRASHED")}
                override fun onKill(s:GeckoSession){if(gate.acceptsSession(epoch))gate.stop("WORKER_ENGINE_KILLED")}
            }
            try{
                channel.attach(GeckoHost.collectorExtension(view.context));if(!live())return gate.reason
                if(!originalDetached){originalDetached=true;parking?.park(::active);view.releaseSession();original.setFocused(false);original.setActive(false);if(parking!=null)observe("ORIGINAL_PARKED")}
                if(!live())return gate.reason
                browser.open(GeckoHost.runtime(view.context));openedSession=true;batchSessions++;observe("BATCH_OPENED")
                view.setSession(browser);browser.setActive(true);browser.setFocused(true);view.requestFocus()
            for((index,previous) in batch){
                if(!live())return gate.reason
                val target=if(fixture)fixtureOrigin!!.trimEnd('/')+"/groups/$group/posts/${previous.postId}/" else previous.permalink
                if(!ReviewDataGate.matches(target,group,previous.postId,fixture)){gate.stop("INPUT");return gate.reason}
                navigating=true;gate.expect(previous.postId);val generation=channel.connectionGeneration
                snapshot(summary("INTERRUPTED"));progress(index+1,queue.size);if(!live())return gate.reason;opened++;val deadline=android.os.SystemClock.elapsedRealtime()+20_000
                // Native loadUri need not emit onLoadRequest; authorize this exact native request first.
                if(!gate.request(target))return gate.reason
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
                if(!live())return gate.reason
                if(!documentReady){
                    gate.stop(when{
                        gate.currentUrl==null->"LOCATION_TIMEOUT"
                        !channel.isConnected||channel.connectionGeneration<=generation||!ReviewDataGate.matches(channel.connectedUrl,group,previous.postId,fixture)->"PORT_TIMEOUT"
                        !view.hasWindowFocus()||!view.hasFocus()->"FOCUS_TIMEOUT"
                        else->"DOM_TIMEOUT"
                    });return gate.reason
                }
                browser.purgeHistory();browser.setFocused(true);view.requestFocus();navigating=false;val portGeneration=channel.connectionGeneration;var reply:ReviewPostReply?=null
                for(attempt in 0..2){
                    delay(500);if(!live()||channel.connectionGeneration!=portGeneration)return if(gate.active)"PORT_LOST" else gate.reason
                    val current=gate.currentUrl?:return "CONTEXT"
                    reply=channel.reviewPost(previous,current,true,group,observe)
                    if(!live()||channel.connectionGeneration!=portGeneration)return if(gate.active)"PORT_LOST" else gate.reason
                    if(reply==null)return channel.reviewFailureReason?:"PROTOCOL"
                    evidence=reply.evidence
                    if(reply.safe!=true)return channel.reviewFailureReason?:"CONTEXT"
                    if(reply.textRead)break
                }
                val result=reply?:return "PROTOCOL";val updated=result.row?:return "PROTOCOL"
                if(result.bound){bound++;onBoundPost(channel,updated,gate.currentUrl?:return "CONTEXT",{live()&&channel.connectionGeneration==portGeneration});if(!live()||channel.connectionGeneration!=portGeneration)return if(gate.active)"PORT_LOST" else gate.reason};if(result.textRead)text++ else unresolved++
                if(!DesktopPresentation.reviewable(updated)&&!DesktopSummary.eligible(updated))filtered++
                else if(ReviewDataSummary.fields(updated)>ReviewDataSummary.fields(previous)||DesktopSummary.eligible(updated)&&!DesktopSummary.eligible(previous))enriched++
                else if(result.textRead)unchanged++
                merged[previous.postId]=updated;unboundStreak=if(result.bound)0 else unboundStreak+1;snapshot(summary("INTERRUPTED"))
                if(unboundStreak>=2){gate.stop("NO_OWN_POST");return gate.reason}
            }
                return if(live())null else gate.reason
            }finally{
                // Revoke callbacks before native close can deliver stale events.
                gate.endSession(epoch);navigating=true
                runCatching{channel.close()}
                runCatching{browser.navigationDelegate=null;browser.progressDelegate=null;browser.contentDelegate=null}
                runCatching{browser.setFocused(false);browser.setActive(false);browser.stop()}
                if(view.session===browser)runCatching{view.releaseSession()}
                if(view.session===browser)gate.stop("ENGINE_LOST")
                if(openedSession){if(runCatching{browser.close()}.isSuccess)batchSessionsClosed++ else gate.stop("ENGINE_LOST")}
                snapshot(summary("INTERRUPTED"));observe("BATCH_CLOSED")
            }
        }
        try{
            val batches=queue.withIndex().toList().chunked(POSTS_PER_SESSION)
            for((index,batch) in batches.withIndex()){
                val stopped=runBatch(batch);if(stopped!=null)return@withContext outcome(stopped)
                if(!active())return@withContext outcome(gate.reason)
                if(index<batches.lastIndex){delay(750);if(!active())return@withContext outcome(gate.reason)}
            }
            outcome("DONE",merged.values.toList())
        }finally{
            gate.stop("CLOSED")
            if(originalDetached)kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable){
                // A newer unrelated session must never be replaced by cleanup.
                if(lastWorker!=null&&view.session===lastWorker)view.releaseSession()
                if(view.session==null&&restoreActive())view.setSession(original)
                val resume=restorePermitted&&view.session===original&&restoreActive()
                runCatching{original.setActive(resume)};if(resume){original.setFocused(true);view.requestFocus()}
                parking?.restore{resume&&restoreActive()}
                if(resume&&parking!=null)observe("ORIGINAL_RESTORED")
            }
        }
    }
}
