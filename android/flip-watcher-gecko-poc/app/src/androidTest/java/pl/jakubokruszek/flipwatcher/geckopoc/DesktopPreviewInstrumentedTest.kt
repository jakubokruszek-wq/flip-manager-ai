package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.geckoview.*
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

/** Real HTTP/Gecko/extension flow, all requests strictly local fixtures. */
@RunWith(AndroidJUnit4::class)
class DesktopPreviewInstrumentedTest {
    private val context:Context=ApplicationProvider.getApplicationContext()
    @Test fun desktopModeCapturesInitialNetworkDomAndHydrationWithSameRunner(){
        ActivityScenario.launch(GeckoTestHostActivity::class.java).use {scenario->
            var host:GeckoTestHostActivity?=null;scenario.onActivity{host=it}
            runBlocking{withTimeout(90_000){withContext(Dispatchers.Main){
                val groupPath="/groups/$FIXTURE_GROUP_ID/"
                val desktop=AtomicBoolean(false);val challenge=AtomicBoolean(false)
                val agents=CopyOnWriteArrayList<String>()
                val server=LoopbackFixtureServer(pages=mapOf("/api/graphql/" to "desktop-network"),onRequest={path,ua->
                    if(path==groupPath){agents.add(ua.orEmpty());desktop.set(ua!=null&&!ua.contains("Mobile",true)&&!ua.contains("Android",true))}
                }){name->
                    val selected=if(name=="fixtures/desktop-start.html"&&!desktop.get())"fixtures/other.html" else name
                    runCatching{context.assets.open(selected).bufferedReader().use{it.readText()}}.getOrNull()?.let{body->
                        if(selected=="fixtures/desktop-start.html"&&challenge.get())body+"<script>setTimeout(function(){document.title='Checkpoint';document.body.insertAdjacentHTML('beforeend','<input type=password>');},1500);</script>" else body
                    }
                }
                val target=server.url(groupPath,"desktop-start")
                val session=GeckoSession(GeckoSessionSettings.Builder().build())
                var gate:DesktopTrial?=null;var current:String?=null;var complete=false
                val channel=CollectorChannel(session,fixtureMode=true,onDesktopStop={gate?.stop("CONTEXT")})
                session.navigationDelegate=object:GeckoSession.NavigationDelegate{
                    override fun onLoadRequest(s:GeckoSession,q:GeckoSession.NavigationDelegate.LoadRequest):GeckoResult<AllowOrDeny>{
                        val allowed=if(gate==null)q.uri==target else gate!!.request(q.uri,q.isRedirect,q.target==GeckoSession.NavigationDelegate.TARGET_WINDOW_NEW,q.hasUserGesture)
                        return GeckoResult.fromValue(if(allowed)AllowOrDeny.ALLOW else AllowOrDeny.DENY)
                    }
                    override fun onLocationChange(s:GeckoSession,u:String?,p:MutableList<GeckoSession.PermissionDelegate.ContentPermission>,gesture:Boolean){current=u;if(gate?.active==true)gate!!.location(u)}
                }
                session.progressDelegate=object:GeckoSession.ProgressDelegate{
                    override fun onPageStart(s:GeckoSession,u:String){complete=false}
                    override fun onPageStop(s:GeckoSession,success:Boolean){complete=success}
                }
                session.contentDelegate=object:GeckoSession.ContentDelegate{
                    override fun onTitleChange(s:GeckoSession,title:String?){if(title?.contains("Checkpoint")==true)gate?.stop("CONTEXT")}
                }
                try{
                    channel.attach(GeckoHost.collectorExtension(context));session.open(GeckoHost.runtime(context));host!!.geckoView.setSession(session);session.setActive(true)
                    session.loadUri(target);assertTrue(channel.awaitPort(15_000));withTimeout(15_000){while(!complete||current!=target)delay(100)}
                    assertTrue(agents.first().contains("Mobile")||agents.first().contains("Android"))
                    val trial=DesktopTrial(target,{android.os.SystemClock.elapsedRealtime()},fixture=true);gate=trial;assertTrue(trial.begin(true))
                    val result=DesktopSessionPreview.run(session,channel,trial,UUID.randomUUID().toString(),target,{current},fixture=true,windowMs=15_000)
                    assertEquals("DONE",result.reason);assertEquals(1,trial.requests)
                    assertTrue(agents.size>=2);assertFalse(agents.last().contains("Mobile",true));assertFalse(agents.last().contains("Android",true))
                    val reply=result.reply!!;assertEquals(1,reply.stats.getValue("desktop"));assertEquals(1,reply.stats.getValue("verified"))
                    assertTrue("initial response missing",reply.stats.getValue("bytes")>0);assertTrue(reply.stats.getValue("network")>=2)
                    assertEquals(3,reply.rows.size);assertEquals(3,reply.rows.map{it.postId}.distinct().size)
                    val listing=reply.rows.single{it.postId=="550000000000091"}
                    assertEquals(319000.0,listing.price!!,0.01);assertEquals(42.42,listing.area!!,0.01);assertEquals(2,listing.rooms!!);assertEquals("Retkinia",listing.neighborhood)
                    assertEquals("MIXED",listing.layer);assertTrue(listing.photos>=1)
                    val wanted=reply.rows.single{it.postId=="550000000000093"};assertEquals("BUY_PROPERTY",wanted.intent);assertNull(wanted.price);assertFalse(DesktopSummary.eligible(wanted))
                    val summary=DesktopSummary.create("DONE",trial.requests,reply);assertEquals("CONDITIONAL_GO",summary.verdict);assertEquals(2,summary.offers)
                    assertFalse(summary.encode().contains("550000000000091"));assertFalse(summary.encode().contains("PRIVATE"))
                    android.util.Log.i("GeckoPocTest","DESKTOP_ACCEPTANCE ${summary.report()}")
                    // Same runner and real page: a verification mutation must discard partial results.
                    challenge.set(true);val unsafe=DesktopTrial(target,{android.os.SystemClock.elapsedRealtime()},fixture=true);gate=unsafe;assertTrue(unsafe.begin(true))
                    val nonce=UUID.randomUUID().toString()
                    val stopped=DesktopSessionPreview.run(session,channel,unsafe,nonce,target,{current},fixture=true,windowMs=15_000)
                    assertEquals("CONTEXT",stopped.reason);assertNull(stopped.reply)
                    assertNull(channel.desktopPreview(nonce,System.currentTimeMillis(),1000,FIXTURE_GROUP_ID))
                    assertEquals("NO_GO",DesktopSummary.create(stopped.reason,unsafe.requests).verdict)
                }finally{channel.abortDesktop();channel.close();host!!.geckoView.releaseSession();session.close();server.close()}
            }}}
        }
    }

    private fun texts(view:android.view.View):String=when(view){
        is android.widget.TextView->view.text.toString()
        is android.view.ViewGroup->(0 until view.childCount).joinToString("\n"){texts(view.getChildAt(it))}
        else->""
    }
    @Test fun localPreviewIsClearedOnPauseAndOnlyAggregateSurvivesAndCopies(){
        val prefs=context.getSharedPreferences("desktop_trial_summary_v1",Context.MODE_PRIVATE)
        val original=prefs.getString("last",null)
        val history=context.getSharedPreferences("gecko_poc",Context.MODE_PRIVATE)
        val key="manual_slug_scan_one_shot_20261017";val existed=history.contains(key);val old=history.getBoolean(key,false)
        val link=context.getSharedPreferences("share_link_terminal_result_v1",Context.MODE_PRIVATE).getString("last",null)
        try{
            history.edit().putBoolean(key,true).commit()
            ActivityScenario.launch(PocActivity::class.java).use{scenario->
                val id="550000000000099"
                val row=DesktopRow(id,"https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/$id/","DOM",319000.0,"EXPLICIT_TOTAL",42.42,2,"Polesie","Retkinia",null,"SELL_PROPERTY",true,1)
                val stats=DesktopProtocol.emptyStats().toMutableMap().apply{put("candidates",1);put("verified",1);put("desktop",1)}
                val summary=DesktopSummary.create("DONE",1,DesktopReply("OK","DONE",listOf(row),stats))
                var oldView:android.view.View?=null
                scenario.onActivity{a->
                    a.publishDesktop(summary,listOf(row));assertTrue(a.desktopResultDialog!!.isShowing)
                    oldView=a.desktopResultDialog!!.window!!.decorView
                    assertTrue(texts(oldView!!).contains(id));assertTrue(texts(oldView!!).contains("319000"))
                    assertFalse(prefs.getString("last","")!!.contains(id));assertFalse(prefs.getString("last","")!!.contains("Retkinia"))
                    a.desktopResultDialog!!.getButton(android.app.AlertDialog.BUTTON_NEUTRAL).performClick()
                }
                var copied:String?=null;val end=System.currentTimeMillis()+5000
                while(copied!=summary.report()&&System.currentTimeMillis()<end){scenario.onActivity{a->copied=a.getSystemService(android.content.ClipboardManager::class.java).primaryClip?.getItemAt(0)?.text?.toString()};runBlocking{delay(50)}}
                assertEquals(summary.report(),copied);assertFalse(copied!!.contains(id))
                scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED);scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
                scenario.onActivity{assertFalse(texts(oldView!!).contains(id))}
                scenario.recreate()
                scenario.onActivity{a->a.findViewById<android.view.ViewGroup>(android.R.id.content).findViewWithTag<android.widget.Button>("poc.tool.tools").performClick()}
                scenario.onActivity{a->a.diagnosticsDialog!!.window!!.decorView.findViewWithTag<android.widget.Button>("poc.tool.desktopResult").performClick()}
                scenario.onActivity{a->assertTrue(a.desktopResultDialog!!.isShowing);assertFalse(texts(a.desktopResultDialog!!.window!!.decorView).contains(id));assertTrue(texts(a.desktopResultDialog!!.window!!.decorView).contains("CONDITIONAL_GO"))}
                assertTrue(history.getBoolean(key,false));assertEquals(link,context.getSharedPreferences("share_link_terminal_result_v1",Context.MODE_PRIVATE).getString("last",null))
            }
        }finally{
            if(original==null)prefs.edit().remove("last").commit() else prefs.edit().putString("last",original).commit()
            if(existed)history.edit().putBoolean(key,old).commit() else history.edit().remove(key).commit()
        }
    }
}
