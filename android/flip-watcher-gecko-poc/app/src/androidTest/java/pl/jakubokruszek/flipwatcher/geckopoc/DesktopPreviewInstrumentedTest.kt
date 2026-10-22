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
            runBlocking{withTimeout(120_000){withContext(Dispatchers.Main){
                val groupPath="/groups/$FIXTURE_GROUP_ID/"
                val desktop=AtomicBoolean(false);val challenge=AtomicBoolean(false);val rootScroll=AtomicBoolean(false);val clipped=AtomicBoolean(false);val hiddenRoot=AtomicBoolean(false)
                val agents=CopyOnWriteArrayList<String>()
                val server=LoopbackFixtureServer(pages=mapOf("/api/graphql/" to "desktop-network"),onRequest={path,ua->
                    if(path==groupPath){agents.add(ua.orEmpty());desktop.set(ua!=null&&!ua.contains("Mobile",true)&&!ua.contains("Android",true))}
                }){name->
                    val selected=if(name=="fixtures/desktop-start.html"&&!desktop.get())"fixtures/other.html" else if(name=="fixtures/desktop-start.html"&&hiddenRoot.get())"fixtures/desktop-hidden-root.html" else if(name=="fixtures/desktop-start.html"&&clipped.get())"fixtures/desktop-tail.html" else name
                    runCatching{context.assets.open(selected).bufferedReader().use{it.readText()}}.getOrNull()?.let{body->
                        val page=if(selected=="fixtures/desktop-start.html"&&rootScroll.get())body.replace("<html>","<html style=\"overflow-y:auto\">").replace("margin:0;height:100vh;overflow:hidden","margin:0;min-height:9000px;overflow:hidden").replace("height:100vh;overflow-y:auto","height:auto;overflow:visible") else body
                        if(selected=="fixtures/desktop-start.html"&&challenge.get())page+"<script>setTimeout(function(){document.title='Checkpoint';document.body.insertAdjacentHTML('beforeend','<input type=password>');},1500);</script>" else page
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
                    val startedAt=android.os.SystemClock.elapsedRealtime()
                    val result=DesktopSessionPreview.run(session,channel,trial,UUID.randomUUID().toString(),target,{current},fixture=true,windowMs=45_000)
                    assertTrue("thirty-second scroll window was skipped",android.os.SystemClock.elapsedRealtime()-startedAt>=30_000)
                    assertEquals("DONE",result.reason);assertEquals(1,trial.requests)
                    assertTrue(agents.size>=2);assertFalse(agents.last().contains("Mobile",true));assertFalse(agents.last().contains("Android",true))
                    val reply=result.reply!!;assertEquals(1,reply.stats.getValue("desktop"));assertEquals(1,reply.stats.getValue("verified"));assertTrue(reply.stats.getValue("scrollMoves") in 5..30);assertTrue(reply.stats.getValue("scrollSteps") in 15..30);assertEquals(1,reply.stats.getValue("scrollInner"));assertTrue(reply.stats.getValue("scrollHit")>0);assertTrue("initial finite feed end was not observed",reply.stats.getValue("scrollAtEnd")>0);assertTrue("lazy feed wait was not observed",reply.stats.getValue("scrollNoTarget")>0);assertTrue(reply.stats.getValue("scrollElapsedMs") in 29000..30000)
                    assertTrue("initial response missing",reply.stats.getValue("bytes")>0);assertTrue(reply.stats.getValue("network")>=2)
                    assertEquals(3,reply.rows.size);assertEquals(3,reply.rows.map{it.postId}.distinct().size)
                    val listing=reply.rows.single{it.postId=="550000000000091"}
                    assertEquals(319000.0,listing.price!!,0.01);assertEquals(42.42,listing.area!!,0.01);assertEquals(2,listing.rooms!!);assertEquals("Retkinia",listing.neighborhood)
                    assertEquals("MIXED",listing.layer);assertEquals("photo grid/SVG/duplicate/comment isolation",3,listing.photos)
                    val second=reply.rows.single{it.postId=="550000000000092"};assertEquals("MIXED",second.layer);assertEquals(425000.0,second.price!!,0.01);assertEquals(53.0,second.area!!,0.01)
                    val wanted=reply.rows.single{it.postId=="550000000000093"};assertEquals("BUY_PROPERTY",wanted.intent);assertNull(wanted.price);assertFalse(DesktopSummary.eligible(wanted));assertEquals("INTENT",wanted.qualification);assertTrue(DesktopPresentation.explanation(wanted).contains("prośba zakupu"))
                    val summary=DesktopSummary.create("DONE",trial.requests,reply);assertEquals("CONDITIONAL_GO",summary.verdict);assertEquals(2,summary.offers)
                    assertFalse(summary.encode().contains("550000000000091"));assertFalse(summary.encode().contains("PRIVATE"))
                    android.util.Log.i("GeckoPocTest","DESKTOP_ACCEPTANCE ${summary.report()}")
                    // A clipped ancestor prevents pagination until the actual bound tail is exposed.
                    clipped.set(true);val tailTrial=DesktopTrial(target,{android.os.SystemClock.elapsedRealtime()},fixture=true);gate=tailTrial;assertTrue(tailTrial.begin(true))
                    val tailResult=DesktopSessionPreview.run(session,channel,tailTrial,UUID.randomUUID().toString(),target,{current},fixture=true,windowMs=15_000)
                    assertEquals("DONE",tailResult.reason);val tailReply=tailResult.reply!!
                    assertTrue("clipped tail alignment absent",tailReply.stats.getValue("scrollTailAttempts") in 1..2)
                    assertTrue("ancestor did not move",tailReply.stats.getValue("scrollTailMoves")>0)
                    assertTrue("inner feed did not resume",tailReply.stats.getValue("scrollMoves")>tailReply.stats.getValue("scrollTailMoves")+2)
                    assertEquals(1,tailReply.stats.getValue("pageFocused"));assertEquals(1,tailReply.stats.getValue("pageVisible"))
                    val resumed=tailReply.rows.single{it.postId=="550000000000094"};assertEquals(950000.0,resumed.price!!,0.01);assertEquals(77.0,resumed.area!!,0.01)
                    clipped.set(false)
                    // HTML owns viewport overflow: hidden BODY must not suppress root scrolling.
                    rootScroll.set(true);val rootTrial=DesktopTrial(target,{android.os.SystemClock.elapsedRealtime()},fixture=true);gate=rootTrial;assertTrue(rootTrial.begin(true))
                    val rootResult=DesktopSessionPreview.run(session,channel,rootTrial,UUID.randomUUID().toString(),target,{current},fixture=true,windowMs=15_000)
                    assertEquals("DONE",rootResult.reason);assertTrue(rootResult.reply!!.stats.getValue("scrollMoves") in 5..30);assertEquals(2,DesktopSummary.create("DONE",rootTrial.requests,rootResult.reply).offers)
                    // Inner end + already visible exact tail must recover hidden-root scrolling.
                    rootScroll.set(false);hiddenRoot.set(true)
                    val hiddenTrial=DesktopTrial(target,{android.os.SystemClock.elapsedRealtime()},fixture=true);gate=hiddenTrial;assertTrue(hiddenTrial.begin(true))
                    val hiddenResult=DesktopSessionPreview.run(session,channel,hiddenTrial,UUID.randomUUID().toString(),target,{current},fixture=true,windowMs=15_000)
                    assertEquals("DONE",hiddenResult.reason);val hiddenReply=hiddenResult.reply!!
                    assertEquals("inner feed must move first",1,hiddenReply.stats.getValue("scrollInner"))
                    assertEquals("hidden root must recover",1,hiddenReply.stats.getValue("scrollRoot"))
                    assertEquals("visible tail must not need alignment",0,hiddenReply.stats.getValue("scrollTailAttempts"))
                    assertTrue("ancestor recovery did not produce new data",hiddenReply.rows.any{it.postId=="550000000000095"&&it.price==650000.0&&it.area==65.0})
                    android.util.Log.i("GeckoPocTest","HIDDEN_ROOT_ACCEPTANCE ${DesktopSummary.create("DONE",hiddenTrial.requests,hiddenReply).report()}")
                    hiddenRoot.set(false);rootScroll.set(true)
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

    @Test fun nativeWheelUnblocksFiniteFeedAndRenderedThumbnailsStayOnlyInRam()=checkNativeViewport(false)
    @Test fun nativeWheelMovesDeepAnonymousScrollerAndRenderedThumbnailsStayOnlyInRam()=checkNativeViewport(true)
    private fun checkNativeViewport(deep:Boolean){
        ActivityScenario.launch(GeckoTestHostActivity::class.java).use {scenario->
            var host:GeckoTestHostActivity?=null;scenario.onActivity{host=it}
            runBlocking{withTimeout(70_000){withContext(Dispatchers.Main){
                val server=LoopbackFixtureServer{asset->
                    val selected=if(asset=="fixtures/desktop-start.html")(if(deep)"fixtures/desktop-viewport-deep.html" else "fixtures/desktop-viewport.html") else asset
                    runCatching{context.assets.open(selected).bufferedReader().use{it.readText()}}.getOrNull()
                }
                val target=server.url("/groups/$FIXTURE_GROUP_ID/","desktop-start")
                val session=GeckoSession(GeckoSessionSettings.Builder().build());val images=DesktopThumbnails()
                var gate:DesktopTrial?=null;var current:String?=null;var loaded=false
                val channel=CollectorChannel(session,fixtureMode=true,onDesktopStop={gate?.stop("CONTEXT")})
                session.navigationDelegate=object:GeckoSession.NavigationDelegate{
                    override fun onLoadRequest(s:GeckoSession,q:GeckoSession.NavigationDelegate.LoadRequest):GeckoResult<AllowOrDeny>{
                        val ok=if(gate==null)q.uri==target else gate!!.request(q.uri,q.isRedirect,q.target==GeckoSession.NavigationDelegate.TARGET_WINDOW_NEW,q.hasUserGesture)
                        return GeckoResult.fromValue(if(ok)AllowOrDeny.ALLOW else AllowOrDeny.DENY)
                    }
                    override fun onLocationChange(s:GeckoSession,u:String?,p:MutableList<GeckoSession.PermissionDelegate.ContentPermission>,gesture:Boolean){current=u;if(gate?.active==true)gate!!.location(u)}
                }
                session.progressDelegate=object:GeckoSession.ProgressDelegate{
                    override fun onPageStart(s:GeckoSession,u:String){loaded=false}
                    override fun onPageStop(s:GeckoSession,success:Boolean){loaded=success}
                }
                try{
                    channel.attach(GeckoHost.collectorExtension(context));session.open(GeckoHost.runtime(context));host!!.geckoView.setSession(session);session.setActive(true)
                    session.loadUri(target);assertTrue(channel.awaitPort(15_000));withTimeout(15_000){while(!loaded||current!=target)delay(100)}
                    val trial=DesktopTrial(target,{android.os.SystemClock.elapsedRealtime()},fixture=true);gate=trial;assertTrue(trial.begin(true))
                    val result=DesktopSessionPreview.run(session,channel,trial,UUID.randomUUID().toString(),target,{current},fixture=true,windowMs=40_000,view=host!!.geckoView,images=images)
                    assertEquals("DONE",result.reason);val reply=result.reply!!
                    android.util.Log.i("GeckoPocTest","VIEWPORT_BEFORE_ASSERT deep=$deep pictures=${images.count} newOffer=${reply.rows.any{it.postId=="550000000000096"}} ${DesktopSummary.create("DONE",trial.requests,reply).report()}")
                    assertTrue("official wheel request absent",reply.stats.getValue("scrollNativeSteps")>0)
                    if(deep)assertTrue("native request ACK is not motion proof",reply.stats.getValue("scrollNativeMoves")>0)
                    else assertTrue("wheel must unlock actual further progress beyond finite initial range",reply.stats.getValue("scrollMoves")>4)
                    assertTrue("wheel must load a NEW exact offer",reply.rows.any{it.postId=="550000000000096"&&it.price==680000.0&&it.area==68.0})
                    val thumbs=images.rows("550000000000091")
                    assertEquals("actual rendered image crops missing",2,thumbs.size)
                    assertTrue(thumbs.all{it.width<=192&&it.height<=144})
                    val colors=thumbs.map{it.getPixel(it.width/2,it.height/2)}
                    assertTrue("red picture missing",colors.any{android.graphics.Color.red(it)>200&&android.graphics.Color.green(it)<40})
                    assertTrue("green picture missing",colors.any{android.graphics.Color.green(it)>200&&android.graphics.Color.red(it)<40})
                    val row=reply.rows.single{it.postId=="550000000000091"}
                    val panel=OffersPanel(context,{},{});panel.showRows(listOf(row),thumbnails={images.rows(it)})
                    val image=panel.findViewWithTag<android.widget.ImageView>("poc.offer.photo.${row.postId}.0")
                    assertNotNull(image.drawable)
                    panel.showRows(emptyList());assertNull(image.drawable)
                    images.clear();assertTrue(thumbs.all{it.isRecycled});assertEquals(0,images.count)
                    assertFalse(DesktopSummary.create("DONE",trial.requests,reply).encode().contains(row.postId))
                    android.util.Log.i("GeckoPocTest","VIEWPORT_ACCEPTANCE ${DesktopSummary.create("DONE",trial.requests,reply).report()}")
                }finally{channel.abortDesktop();images.clear();channel.close();host!!.geckoView.releaseSession();session.close();server.close()}
            }}}
        }
    }

    @Test fun nativeViewportWithoutLiveGateCannotCaptureOrScroll(){
        ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->scenario.onActivity{host->
            val nonce=UUID.randomUUID().toString();val images=DesktopThumbnails()
            val bridge=DesktopViewportBridge(host.geckoView,nonce,images,{false})
            val request=org.json.JSONObject().put("type","desktopViewportRequest").put("nonce",nonce).put("requestId",UUID.randomUUID().toString()).put("action","scroll").put("x",0.5).put("y",0.6)
            var ack:org.json.JSONObject?=null;bridge.handle(request){ack=it}
            assertFalse(ack!!.getBoolean("accepted"));assertEquals(0,images.count)
            bridge.close();ack=null;bridge.handle(request.put("requestId",UUID.randomUUID().toString())){ack=it};assertNull(ack)
        }}
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
                val missing=row.copy(postId="550000000000098",permalink=row.permalink.replace(id,"550000000000098"),price=null,priceSource="NONE",area=null,rooms=null,usable=false,qualification="NO_TEXT")
                stats["candidates"]=2
                val summary=DesktopSummary.create("DONE",1,DesktopReply("OK","DONE",listOf(missing,row),stats))
                var oldView:android.view.View?=null;var oldCards:android.view.View?=null;var oldImage:android.widget.ImageView?=null
                val transientPicture=android.graphics.Bitmap.createBitmap(10,10,android.graphics.Bitmap.Config.ARGB_8888)
                scenario.onActivity{a->
                    assertTrue(a.desktopThumbnails.put(id,0,transientPicture))
                    a.publishDesktop(summary,listOf(missing,row))
                    val root=a.findViewById<android.view.ViewGroup>(android.R.id.content)
                    oldCards=root.findViewWithTag<android.view.View>("poc.offers")
                    assertEquals(android.view.View.VISIBLE,oldCards!!.visibility)
                    oldImage=root.findViewWithTag("poc.offer.photo.$id.0");assertNotNull(oldImage!!.drawable)
                    assertTrue(texts(oldCards!!).contains(id));assertFalse(texts(oldCards!!).contains(missing.postId))
                    root.findViewWithTag<android.widget.Button>("poc.tab.facebook").performClick()
                    root.findViewWithTag<android.widget.Button>("poc.tab.offers").performClick()
                    assertTrue(texts(oldCards!!).contains(id))
                    root.findViewWithTag<android.widget.Button>("poc.offers.report").performClick()
                    assertTrue(a.desktopResultDialog!!.isShowing)
                    oldView=a.desktopResultDialog!!.window!!.decorView
                    assertTrue(texts(oldView!!).contains("Brak tekstu przypisanego do dokładnego ID"));assertTrue(texts(oldView!!).contains(id));assertTrue(texts(oldView!!).contains("42,42 m²"));assertTrue(texts(oldView!!).indexOf("KANDYDAT 1")<texts(oldView!!).indexOf("RAPORT TECHNICZNY"))
                    assertFalse(prefs.getString("last","")!!.contains(id));assertFalse(prefs.getString("last","")!!.contains("Retkinia"))
                    a.desktopResultDialog!!.getButton(android.app.AlertDialog.BUTTON_NEUTRAL).performClick()
                }
                var copied:String?=null;val end=System.currentTimeMillis()+5000
                while(copied!=summary.report()&&System.currentTimeMillis()<end){scenario.onActivity{a->copied=a.getSystemService(android.content.ClipboardManager::class.java).primaryClip?.getItemAt(0)?.text?.toString()};runBlocking{delay(50)}}
                assertEquals(summary.report(),copied);assertFalse(copied!!.contains(id))
                scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED);scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
                scenario.onActivity{assertFalse(texts(oldView!!).contains(id));assertFalse(texts(oldCards!!).contains(id));assertNull(oldImage!!.drawable);assertTrue(transientPicture.isRecycled);assertEquals(0,it.desktopThumbnails.count)}
                scenario.recreate()
                scenario.onActivity{a->a.findViewById<android.view.ViewGroup>(android.R.id.content).findViewWithTag<android.widget.Button>("poc.tool.tools").performClick()}
                scenario.onActivity{a->a.diagnosticsDialog!!.window!!.decorView.findViewWithTag<android.widget.Button>("poc.tool.desktopResult").performClick()}
                scenario.onActivity{a->
                    val panel=a.findViewById<android.view.ViewGroup>(android.R.id.content).findViewWithTag<android.view.View>("poc.offers")
                    assertEquals(android.view.View.VISIBLE,panel.visibility);assertFalse(texts(panel).contains(id));assertTrue(texts(panel).contains("Brak ofert w pamięci"))
                    panel.findViewWithTag<android.widget.Button>("poc.offers.report").performClick()
                    assertTrue(a.desktopResultDialog!!.isShowing);assertFalse(texts(a.desktopResultDialog!!.window!!.decorView).contains(id));assertTrue(texts(a.desktopResultDialog!!.window!!.decorView).contains("CONDITIONAL_GO"))
                }
                assertTrue(history.getBoolean(key,false));assertEquals(link,context.getSharedPreferences("share_link_terminal_result_v1",Context.MODE_PRIVATE).getString("last",null))
            }
        }finally{
            if(original==null)prefs.edit().remove("last").commit() else prefs.edit().putString("last",original).commit()
            if(existed)history.edit().putBoolean(key,old).commit() else history.edit().remove(key).commit()
        }
    }
    @Test fun offerLinkClickIsExplicitExactAndCannotReuseClearedCards(){
        val launched=CopyOnWriteArrayList<android.content.Intent>()
        val instrumentation=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        val monitor=object:android.app.Instrumentation.ActivityMonitor(){
            override fun onStartActivity(intent:android.content.Intent):android.app.Instrumentation.ActivityResult?{
                if(intent.action!=android.content.Intent.ACTION_VIEW)return null
                launched.add(android.content.Intent(intent))
                return android.app.Instrumentation.ActivityResult(android.app.Activity.RESULT_CANCELED,null)
            }
        }
        instrumentation.addMonitor(monitor)
        val prefs=context.getSharedPreferences("desktop_trial_summary_v1",Context.MODE_PRIVATE);val saved=prefs.getString("last",null)
        try{
            ActivityScenario.launch(PocActivity::class.java).use{scenario->
                val id="550000000000097"
                val row=DesktopRow(id,"https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/$id/","NETWORK",319000.0,"EXPLICIT_TOTAL",42.42,2,"Polesie","Retkinia",null,"SELL_PROPERTY",true,1,"CANDIDATE")
                val stats=DesktopProtocol.emptyStats().toMutableMap().apply{put("candidates",1);put("verified",1);put("desktop",1)}
                val summary=DesktopSummary.create("DONE",1,DesktopReply("OK","DONE",listOf(row),stats))
                var stale:android.widget.Button?=null
                scenario.onActivity{a->
                    a.publishDesktop(summary,listOf(row))
                    val root=a.findViewById<android.view.ViewGroup>(android.R.id.content)
                    assertTrue(launched.isEmpty()) // Showing/switching tabs never opens a link.
                    stale=root.findViewWithTag("poc.offer.open.$id")
                    assertTrue(stale!!.isEnabled);stale!!.performClick()
                    assertEquals(1,launched.size);assertEquals(row.permalink,launched.single().dataString)
                    assertNull(launched.single().extras);assertTrue(launched.single().hasCategory(android.content.Intent.CATEGORY_BROWSABLE))
                    assertFalse(texts(root.findViewWithTag("poc.offers")).contains(id))
                    assertNull(stale!!.tag);assertEquals("",stale!!.text.toString())
                    stale!!.performClick();assertEquals(1,launched.size)
                    assertFalse(prefs.getString("last","")!!.contains(id))
                }
                scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED);scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
                scenario.onActivity{stale!!.performClick();assertEquals(1,launched.size)}
            }
        }finally{instrumentation.removeMonitor(monitor);if(saved==null)prefs.edit().remove("last").commit() else prefs.edit().putString("last",saved).commit()}
    }
    @Test fun switchingRealGeckoBetweenTabsKeepsTheSameDocumentAndPort(){
        val prefs=context.getSharedPreferences("desktop_trial_summary_v1",Context.MODE_PRIVATE);val saved=prefs.getString("last",null)
        try{
            ActivityScenario.launch(PocActivity::class.java).use{scenario->
                var activity:PocActivity?=null;scenario.onActivity{activity=it}
                runBlocking{withTimeout(40_000){withContext(Dispatchers.Main){
                    val a=activity!!;val root=a.findViewById<android.view.ViewGroup>(android.R.id.content)
                    val view=root.findViewWithTag<GeckoView>("poc.browser")
                    val server=LoopbackFixtureServer{asset->runCatching{context.assets.open(asset).bufferedReader().use{it.readText()}}.getOrNull()}
                    val target=server.url("/groups/$FIXTURE_GROUP_ID/","desktop-start")
                    val session=GeckoSession(GeckoSessionSettings.Builder().build())
                    var disconnects=0
                    val channel=CollectorChannel(session,fixtureMode=true,onPageDisconnect={disconnects++})
                    try{
                        channel.attach(GeckoHost.collectorExtension(context));session.open(GeckoHost.runtime(context));view.setSession(session);session.setActive(true)
                        session.loadUri(target);assertTrue(channel.awaitPort(15_000));val generation=channel.connectionGeneration
                        val id="550000000000096"
                        val row=DesktopRow(id,"https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/$id/","DOM",319000.0,"EXPLICIT_TOTAL",42.42,2,null,null,null,"SELL_PROPERTY",true,0,"CANDIDATE")
                        val stats=DesktopProtocol.emptyStats().toMutableMap().apply{put("candidates",1);put("verified",1);put("desktop",1)}
                        a.publishDesktop(DesktopSummary.create("DONE",1,DesktopReply("OK","DONE",listOf(row),stats)),listOf(row))
                        repeat(2){
                            delay(400);assertTrue(channel.isConnected);assertEquals(generation,channel.connectionGeneration)
                            root.findViewWithTag<android.widget.Button>("poc.tab.facebook").performClick();delay(200)
                            root.findViewWithTag<android.widget.Button>("poc.tab.offers").performClick()
                        }
                        assertTrue(texts(root.findViewWithTag("poc.offers")).contains(id));assertTrue(channel.isConnected);assertEquals(0,disconnects);assertEquals(target,channel.connectedUrl)
                    }finally{channel.close();view.releaseSession();session.close();server.close()}
                }}}
            }
        }finally{if(saved==null)prefs.edit().remove("last").commit() else prefs.edit().putString("last",saved).commit()}
    }
}
