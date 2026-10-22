package pl.jakubokruszek.flipwatcher.geckopoc

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoSessionSettings

/** Same orchestrator in the activity and the real-Gecko emulator acceptance test. */
object DesktopSessionPreview {
    data class Outcome(val reason:String,val reply:DesktopReply?,val userAgent:String?)
    suspend fun run(session:GeckoSession,channel:CollectorChannel,gate:DesktopTrial,nonce:String,target:String,
                    currentUrl:()->String?,fixture:Boolean=false,windowMs:Int=60_000,view:org.mozilla.geckoview.GeckoView?=null,images:DesktopThumbnails?=null):Outcome=withContext(Dispatchers.Main){
        val group=if(fixture)FIXTURE_GROUP_ID else PocPolicy.APPROVED_GROUP_ID
        var ua:String?=null
        val start=android.os.SystemClock.elapsedRealtime()
        fun remaining()=minOf(gate.remainingMs,windowMs.toLong()-(android.os.SystemClock.elapsedRealtime()-start)).coerceAtLeast(0)
        fun live():Boolean {if(remaining()==0L&&gate.active)gate.stop("DEADLINE_${gate.phase.name}");return gate.tick()}
        fun failure(reason:String):Outcome {if(gate.active)gate.stop(reason);return Outcome(gate.reason,null,ua)}
        try {
            val sourceGeneration=channel.connectionGeneration
            val previousDocument=channel.desktopDocumentProof(group)?:return@withContext failure("PROTOCOL")
            if(!live())return@withContext failure(gate.reason)
            if(channel.connectionGeneration!=sourceGeneration||channel.connectedUrl!=target)return@withContext failure("NAVIGATION")
            val armed=channel.armDesktop(nonce,true,group,windowMs)
            if(!live())return@withContext failure(gate.reason)
            if(armed!="ARMED")return@withContext failure("ARM_${armed.takeIf{it in setOf("STOP","BUSY","UNSUPPORTED")}?:"STOP"}")
            if(!gate.armed())return@withContext failure(gate.reason)
            session.setActive(true);session.setFocused(true)
            session.settings.userAgentMode=GeckoSessionSettings.USER_AGENT_MODE_DESKTOP
            session.settings.viewportMode=GeckoSessionSettings.VIEWPORT_MODE_DESKTOP
            val resolvedUa=withTimeoutOrNull(remaining().coerceAtMost(5_000)){session.userAgent.await()}
            ua=resolvedUa
            if(!live())return@withContext failure(gate.reason)
            if(session.settings.userAgentMode!=GeckoSessionSettings.USER_AGENT_MODE_DESKTOP||session.settings.viewportMode!=GeckoSessionSettings.VIEWPORT_MODE_DESKTOP||resolvedUa==null||resolvedUa.contains("Mobile",true)||resolvedUa.contains("Android",true))return@withContext failure("DESKTOP_NOT_APPLIED")
            if(!live())return@withContext failure(gate.reason)
            if(channel.connectionGeneration!=sourceGeneration)return@withContext failure("NAVIGATION")
            val portAfter=sourceGeneration
            val documentAfter=System.currentTimeMillis()
            session.loadUri(target)
            while(live()){
                val expected=currentUrl()
                if(!gate.located||expected!=gate.requested){gate.waitFor(DesktopTrial.Phase.LOCATION);delay(100);continue}
                if(!channel.isConnected||channel.connectionGeneration<=portAfter||channel.connectedUrl!=expected){gate.waitFor(DesktopTrial.Phase.PORT);delay(100);continue}
                gate.waitFor(DesktopTrial.Phase.READING)
                val generation=channel.connectionGeneration
                session.setFocused(true)
                if(view!=null&&images!=null&&channel.viewportBridge==null)channel.viewportBridge=DesktopViewportBridge(view,nonce,images,{
                    live()&&gate.phase==DesktopTrial.Phase.READING&&currentUrl()==expected&&channel.connectionGeneration==generation&&channel.connectedUrl==expected
                })
                val reply=channel.desktopPreview(nonce,documentAfter,remaining().toInt(),group,previousDocument)
                if(!live())return@withContext failure(gate.reason)
                if(currentUrl()!=expected||generation!=channel.connectionGeneration)return@withContext failure("NAVIGATION")
                if(reply==null)return@withContext failure(if(channel.isConnected)"PROTOCOL" else "PORT_LOST")
                if(reply.status=="WAIT_FRESH"){gate.waitFor(DesktopTrial.Phase.FRESHNESS);delay(200);continue}
                if(reply.status!="OK")return@withContext failure(reply.reason.takeIf{it in DesktopTrial.reasons}?:"PROTOCOL")
                if(reply.stats.getValue("desktop")!=1)return@withContext failure("DESKTOP_NOT_APPLIED")
                if(!gate.complete())return@withContext failure(gate.reason)
                return@withContext Outcome("DONE",reply,ua)
            }
            failure(gate.reason)
        } finally {
            channel.abortDesktop()
            GeckoHost.background.abortDesktop(nonce)
        }
    }
}
