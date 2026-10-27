package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.launch
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
    // Local fixture only: normal Android touch input, never included in the app APK.
    private suspend fun fixtureSwipe(view:GeckoView){
        val down=android.os.SystemClock.uptimeMillis();val x=view.width*.75f;val start=view.height*.8f
        fun send(action:Int,y:Float){val e=android.view.MotionEvent.obtain(down,android.os.SystemClock.uptimeMillis(),action,x,y,0);e.source=android.view.InputDevice.SOURCE_TOUCHSCREEN;try{view.onTouchEvent(e)}finally{e.recycle()}}
        send(android.view.MotionEvent.ACTION_DOWN,start)
        try{delay(50);for(i in 1..12){send(android.view.MotionEvent.ACTION_MOVE,start-view.height*.5f*i/12);delay(40)}}
        finally{send(android.view.MotionEvent.ACTION_UP,start-view.height*.5f)}
    }
    // InputManager dispatch through the actual foreground window, not view.onTouchEvent.
    private suspend fun fixtureScreenTouch(x:Float,y:Float,swipe:Boolean,distance:Float=0f)=withContext(Dispatchers.IO){
        val input=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        val down=android.os.SystemClock.uptimeMillis()
        fun send(action:Int,at:Float){val e=android.view.MotionEvent.obtain(down,android.os.SystemClock.uptimeMillis(),action,x,at,0);e.source=android.view.InputDevice.SOURCE_TOUCHSCREEN;try{input.sendPointerSync(e)}finally{e.recycle()}}
        send(android.view.MotionEvent.ACTION_DOWN,y)
        try{if(swipe){android.os.SystemClock.sleep(50);for(i in 1..12){send(android.view.MotionEvent.ACTION_MOVE,y-distance*i/12);android.os.SystemClock.sleep(40)}}}
        finally{send(android.view.MotionEvent.ACTION_UP,if(swipe)y-distance else y)}
    }
    private suspend fun fixtureScreenshot(name:String)=withContext(Dispatchers.IO){
        val bitmap=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        assertNotNull("local fixture screenshot unavailable",bitmap)
        try{java.io.File(context.filesDir,"$name.png").outputStream().use{assertTrue(bitmap!!.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it))}}finally{bitmap?.recycle()}
    }
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
                    val result=DesktopSessionPreview.run(session,channel,trial,UUID.randomUUID().toString(),target,{current},pageReady={complete},fixture=true,windowMs=45_000)
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
                    val tailResult=DesktopSessionPreview.run(session,channel,tailTrial,UUID.randomUUID().toString(),target,{current},pageReady={complete},fixture=true,windowMs=15_000)
                    assertEquals("DONE",tailResult.reason);val tailReply=tailResult.reply!!
                    assertTrue("clipped tail alignment absent",tailReply.stats.getValue("scrollTailAttempts") in 1..2)
                    assertTrue("ancestor did not move",tailReply.stats.getValue("scrollTailMoves")>0)
                    assertTrue("inner feed did not resume",tailReply.stats.getValue("scrollMoves")>tailReply.stats.getValue("scrollTailMoves")+2)
                    assertEquals(1,tailReply.stats.getValue("pageFocused"));assertEquals(1,tailReply.stats.getValue("pageVisible"))
                    val resumed=tailReply.rows.single{it.postId=="550000000000094"};assertEquals(950000.0,resumed.price!!,0.01);assertEquals(77.0,resumed.area!!,0.01)
                    clipped.set(false)
                    // HTML owns viewport overflow: hidden BODY must not suppress root scrolling.
                    rootScroll.set(true);val rootTrial=DesktopTrial(target,{android.os.SystemClock.elapsedRealtime()},fixture=true);gate=rootTrial;assertTrue(rootTrial.begin(true))
                    val rootResult=DesktopSessionPreview.run(session,channel,rootTrial,UUID.randomUUID().toString(),target,{current},pageReady={complete},fixture=true,windowMs=15_000)
                    assertEquals("DONE",rootResult.reason);assertTrue(rootResult.reply!!.stats.getValue("scrollMoves") in 5..30);assertEquals(2,DesktopSummary.create("DONE",rootTrial.requests,rootResult.reply).offers)
                    // Inner end + already visible exact tail must recover hidden-root scrolling.
                    rootScroll.set(false);hiddenRoot.set(true)
                    val hiddenTrial=DesktopTrial(target,{android.os.SystemClock.elapsedRealtime()},fixture=true);gate=hiddenTrial;assertTrue(hiddenTrial.begin(true))
                    val hiddenResult=DesktopSessionPreview.run(session,channel,hiddenTrial,UUID.randomUUID().toString(),target,{current},pageReady={complete},fixture=true,windowMs=15_000)
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
                    val stopped=DesktopSessionPreview.run(session,channel,unsafe,nonce,target,{current},pageReady={complete},fixture=true,windowMs=15_000)
                    assertEquals("CONTEXT",stopped.reason);assertNull(stopped.reply)
                    assertNull(channel.desktopPreview(nonce,System.currentTimeMillis(),1000,FIXTURE_GROUP_ID))
                    assertEquals("NO_GO",DesktopSummary.create(stopped.reason,unsafe.requests).verdict)
                }finally{channel.abortDesktop();channel.close();host!!.geckoView.releaseSession();session.close();server.close()}
            }}}
        }
    }

    @Test fun nativeWheelUnblocksFiniteFeedAndRenderedThumbnailsStayOnlyInRam()=checkNativeViewport(false)
    @Test fun nativeWheelMovesDeepAnonymousScrollerAndRenderedThumbnailsStayOnlyInRam()=checkNativeViewport(true)
    @Test fun nativeWheelAndRealThumbnailsWorkWithOnlyNetworkPostIdentity()=checkNativeViewport(true,true)
    @Test fun nativeWheelReturnsToRecentlyMovedFeedWithoutSemanticOrPostIdentity()=checkNativeViewport(false,false,true)
    @Test fun nativeWheelUsesSafeMarginWhenCentralIframeBlocksOldProbes()=checkNativeViewport(true,false,false,true)
    @Test fun anonymousAncestorHitScrollsAndCapturesDelegatedImages()=checkNativeViewport(true,false,false,false,true)
    @Test fun baselineScrollIgnoresAvailableNativeViewAndCapturesNoPixels()=checkNativeViewport(false,baseline=true)
    @Test fun trustedSwipeSelectsActualPaneAndAutomaticContinuationIgnoresFiniteDecoy()=checkNativeViewport(false,baseline=true,gesture=true)
    @Test fun consentDismissalReturnsRealWindowTouchToDesktopPane()=checkNativeViewport(false,baseline=true,gesture=true,consentWindow=true)
    @Test fun knownNotificationOverlayIsClosedBeforeRealWindowSwipeAndThirtyMoves()=checkNativeViewport(false,baseline=true,gesture=true,consentWindow=true,noticeWindow=true)
    @Test fun labelledByNotificationDialogClosesBeforeRealWindowSwipe()=checkNativeViewport(false,baseline=true,gesture=true,consentWindow=true,noticeWindow=true,noticeVariant=1)
    @Test fun exactNotificationDescriptionClosesUnlabelledDialogBeforeRealWindowSwipe()=checkNativeViewport(false,baseline=true,gesture=true,consentWindow=true,noticeWindow=true,noticeVariant=2)
    @Test fun unknownAlertDialogIsNeverClickedAndStopsBeforeGesture()=checkNativeViewport(false,baseline=true,gesture=true,consentWindow=true,noticeWindow=true,unknownNotice=true)
    @Test fun noOperatorGestureNeverStartsAutomaticScrollOrPixelReadback()=checkNativeViewport(false,baseline=true,gesture=true,noGesture=true)
    @Test fun alreadyDecodedCssPhotosCaptureRealColorsAndPreserveFurtherScroll()=checkNativeViewport(false,cssPhotos=true)
    @Test fun ordinaryPostContainerNamedCommentableDoesNotDiscardRealImgPhotos()=checkNativeViewport(false,postWrapper=true)
    @Test fun fastAutomaticCadenceMovesMoreThanFortyTimesWithoutOperatorGesture()=checkNativeViewport(false,baseline=true,fastScroll=true)
    @Test fun fastAutomaticCssPhotosShowEligibleOffersWithoutOperatorGesture()=checkNativeViewport(false,cssPhotos=true,fastScroll=true)
    @Test fun singleRasterSvgPhotosUseVisibleRootAndShowActualOfferImages()=checkNativeViewport(false,fastScroll=true,svgPhotos=true)
    @Test fun coloredTextPostRetainsColloquialAreaAndLabelsDerivedPrice()=checkNativeViewport(false,baseline=true,fastScroll=true,colloquial=true)
    @Test fun unclassifiedExactPostsHaveSeparateReviewLinksAndClearOnPause(){
        ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->scenario.onActivity{host->
            val id="550000000000091"
            val offer=DesktopRow(id,"https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/$id/","DOM",319000.0,"EXPLICIT_TOTAL",42.0,2,null,null,null,"SELL_PROPERTY",true,0)
            val reviewId="550000000000092"
            val review=offer.copy(postId=reviewId,permalink=offer.permalink.replace(id,reviewId),price=319000.0,priceSource="EXPLICIT_TOTAL",area=null,rooms=null,intent="UNKNOWN",usable=false,qualification="NOT_PROPERTY")
            val buyer=review.copy(postId="550000000000093",permalink=review.permalink.replace(reviewId,"550000000000093"),intent="BUY_PROPERTY")
            var opened:String?=null;val panel=OffersPanel(host,{opened=it.postId},{})
            val picture=android.graphics.Bitmap.createBitmap(8,8,android.graphics.Bitmap.Config.ARGB_8888)
            host.setContentView(panel);panel.showRows(listOf(offer,review,buyer),thumbnails={if(it==reviewId)listOf(picture)else emptyList()})
            val image=panel.findViewWithTag<android.widget.ImageView>("poc.review.photo.$reviewId.0")
            assertNotNull(image);assertNotNull(image.drawable)
            assertTrue(panel.findViewWithTag<android.widget.TextView>("poc.review.fields.$reviewId").text.toString().contains("319"))
            assertNotNull(panel.findViewWithTag<android.view.View>("poc.offer.card.$id"))
            assertNull(panel.findViewWithTag<android.view.View>("poc.offer.card.$reviewId"))
            val link=panel.findViewWithTag<android.widget.TextView>("poc.review.link.$reviewId")
            assertNotNull(link);assertEquals(review.permalink,link.text.toString());assertTrue(link.performClick());assertEquals(reviewId,opened)
            val open=panel.findViewWithTag<android.widget.Button>("poc.review.open.$reviewId")
            assertNotNull(open);opened=null;assertTrue(open.performClick());assertEquals(reviewId,opened)
            assertNull(panel.findViewWithTag<android.view.View>("poc.review.open.${buyer.postId}"))
            assertNull(panel.findViewWithTag<android.view.View>("poc.review.link.${buyer.postId}"))
            panel.showRows(listOf(review));assertNotNull(panel.findViewWithTag<android.view.View>("poc.offers.review"))
            val reviewOnly=panel.findViewWithTag<android.widget.TextView>("poc.review.link.$reviewId")
            assertEquals(review.permalink,reviewOnly.text.toString())
            panel.showRows(emptyList());assertNull(image.drawable);picture.recycle();assertEquals("",link.text.toString());assertFalse(link.performClick())
            assertEquals("",reviewOnly.text.toString());assertFalse(reviewOnly.performClick());assertEquals("",open.text.toString());assertFalse(open.performClick())
        }}
    }
    @Test fun actualSvgAnchorLinksCapturePhotosWithoutChangingAutomaticScroll()=checkNativeViewport(false,fastScroll=true,svgPhotos=true,svgAnchor=true)
    @Test fun exactNetworkMediaOutsideArticlesCapturesRealImagesAndContinuesScrolling()=checkNativeViewport(false,networkOnly=true,fastScroll=true,documentPhotos=true)
    @Test fun exactOwnMessageDisclosureFillsMissingFieldsAndPreservesAutomaticScroll()=checkNativeViewport(false,baseline=true,fastScroll=true,fullMessage=true)
    @Test fun ariaBoundShortDisclosureOutsideMessageFillsFieldsAndKeepsScrolling()=checkNativeViewport(false,baseline=true,fastScroll=true,fullMessage=true,ariaMessage=true)
    private fun checkNativeViewport(deep:Boolean,networkOnly:Boolean=false,cachedFeed:Boolean=false,marginOnly:Boolean=false,delegated:Boolean=false,baseline:Boolean=false,gesture:Boolean=false,noGesture:Boolean=false,consentWindow:Boolean=false,noticeWindow:Boolean=false,unknownNotice:Boolean=false,noticeVariant:Int=0,cssPhotos:Boolean=false,postWrapper:Boolean=false,fastScroll:Boolean=false,svgPhotos:Boolean=false,colloquial:Boolean=false,svgAnchor:Boolean=false,documentPhotos:Boolean=false,fullMessage:Boolean=false,ariaMessage:Boolean=false){
        ActivityScenario.launch(GeckoTestHostActivity::class.java).use {scenario->
            var host:GeckoTestHostActivity?=null;scenario.onActivity{host=it
                if(consentWindow){
                    val view=it.geckoView;(view.parent as android.view.ViewGroup).removeView(view)
                    val root=android.widget.LinearLayout(it).apply{orientation=android.widget.LinearLayout.VERTICAL}
                    root.addView(android.widget.TextView(it).apply{text="Local trial: waiting for a real swipe"})
                    root.addView(android.widget.Button(it).apply{text="Disabled tool";isEnabled=false})
                    root.addView(android.widget.FrameLayout(it).apply{addView(view,android.widget.FrameLayout.LayoutParams(-1,-1))},android.widget.LinearLayout.LayoutParams(-1,0,1f))
                    it.setContentView(root)
                }
            }
            runBlocking{withTimeout(70_000){withContext(Dispatchers.Main){
                val gestureSeen=AtomicBoolean(false);val noticeDismissed=AtomicBoolean(false)
                val server=LoopbackFixtureServer(pages=if(networkOnly)mapOf("/api/graphql/" to "network-media")else emptyMap(),onRequest={path,_->if(path=="/gesture-ready")gestureSeen.set(true);if(path=="/notice-dismissed")noticeDismissed.set(true)}){asset->
                    if(networkOnly&&asset=="fixtures/network-media.html")"""{"post_id":"550000000000091","url":"https://www.facebook.com/groups/1234567890123/posts/550000000000091/","message":{"text":"Sprzedam mieszkanie 42m2. Cena 319000 zł."},"attachments":[{"media":{"__typename":"Photo","photo_id":"880000000000001","image":{"uri":"https://scontent.fbcdn.net/red.jpg"}}},{"media":{"__typename":"Photo","photo_id":"880000000000002","image":{"uri":"https://scontent.fbcdn.net/green.jpg"}}}]}""".let{if(documentPhotos)it.replace("\"photo_id\":","\"id\":").replace("\"image\":","\"viewer_image\":")else it}
                    else {
                    val selected=if(asset=="fixtures/desktop-start.html")(if(ariaMessage)"fixtures/desktop-full-message-aria.html" else if(fullMessage)"fixtures/desktop-full-message.html" else if(documentPhotos)"fixtures/desktop-viewport-document.html" else if(colloquial)"fixtures/desktop-colloquial.html" else if(noticeWindow)"fixtures/desktop-notice.html" else if(gesture)"fixtures/desktop-gesture.html" else if(baseline)"fixtures/desktop-start.html" else if(svgAnchor)"fixtures/desktop-viewport-svg-anchor.html" else if(svgPhotos)"fixtures/desktop-viewport-svg.html" else if(postWrapper)"fixtures/desktop-viewport-commentable.html" else if(cssPhotos)"fixtures/desktop-viewport-css.html" else if(deep)"fixtures/desktop-viewport-deep.html" else "fixtures/desktop-viewport.html") else asset
                    runCatching{context.assets.open(selected).bufferedReader().use{it.readText()}}.getOrNull()?.let{html->val described=when(noticeVariant){
                        1->html.replace("role=\"alertdialog\"", "role=\"dialog\"").replace("aria-label=\"Push notifications request\"", "aria-labelledby=\"notice-name\"").replace("<span style=", "<span id=\"notice-name\">Push notifications request</span><span style=")
                        2->html.replace("role=\"alertdialog\"", "role=\"dialog\"").replace("aria-label=\"Push notifications request\"", "aria-label=\"Informacje\"")
                        else->html
                    };if(baseline)described.replace("height:1800px",(if(fastScroll)"height:100000px" else "height:50000px")).let{if(unknownNotice)it.replace("Push notifications request","Security verification")else it}else if(networkOnly)html.replace("<a href=\"https://www.facebook.com/groups/1234567890123/posts/550000000000091/\">Post</a>","<span>Post without DOM identity</span>").replace("<head>","<head><script>fetch('/api/graphql/').then(r=>r.text());</script>")else if(cachedFeed)html.replace("</main>","<div style=\"height:6000px\" id=\"blank-tail\"></div></main>").replace("<main role=\"feed\"", "<div id=\"feed\"").replace("</main>","</div>").replace("document.querySelector('main')","document.querySelector('#feed')").replace("groups/1234567890123/posts/550000000000091/","groups/other/posts/550000000000091/").replace("groups/1234567890123/posts/550000000000092/","groups/other/posts/550000000000092/").replace("<div role=\"article\" style=\"height:20px\">","<div style=\"height:20px\">")else if(delegated)html.replace("<main style=", "<div id=\"feed\" style=").replace("</main>","</div>").replace("document.querySelector('main')","document.querySelector('#feed')").replace("height:9000px", "height:50000px;pointer-events:none")else if(marginOnly)html.replace("height:9000px","height:50000px").replace("</body>","<iframe sandbox=\"\" style=\"position:fixed;left:20vw;top:20vh;width:60vw;height:60vh;z-index:10000\"></iframe></body>")else html}
                    }
                }
                val target=server.url("/groups/$FIXTURE_GROUP_ID/","desktop-start")
                val session=GeckoSession(GeckoSessionSettings.Builder().build());val images=DesktopThumbnails()
                var gate:DesktopTrial?=null;var current:String?=null;var loaded=false
                var allowPage=!consentWindow;var waiting=false
                val channel=CollectorChannel(session,fixtureMode=true,onDesktopStop={gate?.stop("CONTEXT")},onDesktopGesture={stage->
                    if(stage=="WAITING"){
                        if(consentWindow){assertTrue("gesture hint before native page completion",loaded&&allowPage);assertTrue("gesture hint while another window owns input",host!!.geckoView.hasWindowFocus())}
                        waiting=true
                    }
                })
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
                    val trial=DesktopTrial(target,{android.os.SystemClock.elapsedRealtime()},fixture=true);gate=trial
                    if(noticeWindow){
                        val v=host!!.geckoView;val p=IntArray(2);v.getLocationOnScreen(p)
                        fixtureScreenTouch(p[0]+v.width*.75f,p[1]+v.height*.8f,swipe=true,distance=v.height*.5f)
                        delay(300);assertFalse("fixture must reproduce the blocked manual swipe before Close",gestureSeen.get());assertFalse(noticeDismissed.get())
                        if(!unknownNotice)fixtureScreenshot("notice-before")
                    }
                    if(consentWindow){
                        var accepted=false
                        val dialog=DesktopConsentDialog(host!!){host!!.geckoView.requestFocus();assertTrue(trial.begin(true));accepted=true}
                        dialog.show()
                        delay(300)
                        val accept=dialog.window!!.decorView.findViewWithTag<android.widget.Button>("poc.desktop.consentAccept")
                        val location=IntArray(2);accept.getLocationOnScreen(location)
                        fixtureScreenTouch(location[0]+accept.width*.5f,location[1]+accept.height*.5f,swipe=false)
                        withTimeout(3000){while(!accepted)delay(20)}
                        assertFalse(dialog.isShowing)
                    }else assertTrue(trial.begin(true))
                    val generation=channel.connectionGeneration
                    val readiness=if(consentWindow)launch{
                        withTimeout(15_000){while(channel.connectionGeneration<=generation||!loaded)delay(50)}
                        delay(400);assertFalse("prompt consumed operator window before page readiness",waiting)
                        val blocker=android.app.AlertDialog.Builder(host!!).setMessage("Local focus readiness fixture").create()
                        blocker.show()
                        try{
                            withTimeout(3000){while(host!!.geckoView.hasWindowFocus())delay(20)}
                            allowPage=true;delay(400)
                            assertFalse("prompt must not start behind a native window",waiting)
                            assertEquals(DesktopTrial.Phase.FOCUS,trial.phase)
                        }finally{blocker.dismiss()}
                    }else null
                    val operator=if(gesture&&!noGesture&&!unknownNotice)launch{
                        while(if(consentWindow)!waiting else trial.phase!=DesktopTrial.Phase.READING)delay(100)
                        delay(3000)
                        if(noticeWindow){assertTrue("ordinary notification Close was not activated",noticeDismissed.get());fixtureScreenshot("notice-after")}
                        repeat(3){if(gestureSeen.get())return@launch
                            if(consentWindow){
                                val v=host!!.geckoView;val p=IntArray(2);v.getLocationOnScreen(p)
                                assertTrue("browser window must own real input after consent",v.hasWindowFocus())
                                fixtureScreenTouch(p[0]+v.width*.75f,p[1]+v.height*.8f,swipe=true,distance=v.height*.5f)
                            }else fixtureSwipe(host!!.geckoView)
                            delay(500)
                        }
                    }else null
                    val result=DesktopSessionPreview.run(session,channel,trial,UUID.randomUUID().toString(),target,{current},pageReady={loaded&&allowPage},fixture=true,windowMs=40_000,view=host!!.geckoView,images=images,baseline=baseline,gesture=gesture,fastScroll=fastScroll)
                    readiness?.join();operator?.cancel()
                    if(unknownNotice){
                        assertEquals("NOTICE_BLOCKED",result.reason);assertNotNull(result.reply);assertTrue(result.reply!!.rows.isEmpty())
                        assertFalse(waiting);assertFalse(noticeDismissed.get());assertFalse(gestureSeen.get());assertEquals(0,result.reply!!.stats.getValue("scrollSteps"));assertEquals(0,images.count)
                        assertEquals(3,result.reply!!.stats.getValue("noticeReason"));assertEquals(1,result.reply!!.stats.getValue("verified"));assertEquals(1,result.reply!!.stats.getValue("desktop"))
                        assertFalse(DesktopSummary.create("NOTICE_BLOCKED",trial.requests,result.reply).report().contains("Żądania danych"))
                        return@withContext
                    }
                    assertEquals("DONE",result.reason);val reply=result.reply!!
                    if(noticeWindow){assertEquals(1,reply.stats.getValue("noticeDetected"));assertEquals(1,reply.stats.getValue("noticeClosed"));assertTrue(noticeDismissed.get());assertEquals(if(noticeVariant==1)2 else if(noticeVariant==2)3 else 1,reply.stats.getValue("noticeNameSource"))}
                    android.util.Log.i("GeckoPocTest","NATIVE_CAPTURE_COUNTS ${channel.lastViewportCaptureCounts.joinToString(",")}")
                    android.util.Log.i("GeckoPocTest","VIEWPORT_BEFORE_ASSERT deep=$deep networkOnly=$networkOnly cssPhotos=$cssPhotos fastScroll=$fastScroll svgPhotos=$svgPhotos delegated=$delegated baseline=$baseline gesture=$gesture notice=$noticeWindow variant=$noticeVariant pictures=${images.count} newOffer=${reply.rows.any{it.postId=="550000000000096"}} ${DesktopSummary.create("DONE",trial.requests,reply).report()}")
                    if(fastScroll){assertEquals(1,reply.stats.getValue("scrollFast"));assertEquals(500,reply.stats.getValue("scrollCadenceMs"));assertEquals(0,reply.stats.getValue("gestureRequested"));assertEquals(0,reply.stats.getValue("gestureTouches"))}
                    if(noGesture){
                        assertEquals(0,reply.stats.getValue("gestureAnchored"));assertEquals(0,reply.stats.getValue("scrollSteps"))
                        assertTrue(reply.stats.getValue("gestureWaitMs") in 14000..15000)
                        for(key in listOf("nativeRequests","photoPreviewFrames","photoPreviews"))assertEquals(0,reply.stats.getValue(key))
                        assertEquals(0,images.count);assertTrue(channel.lastViewportCaptureCounts.isEmpty());return@withContext
                    }
                    if(gesture){
                        assertTrue("real local pane must have moved",gestureSeen.get())
                        assertEquals("browser-trusted swipe must select the actual pane",1,reply.stats.getValue("gestureAnchored"))
                        assertTrue("automatic continuation must outlast finite decoy",reply.stats.getValue("gestureScrollMoves")>=25)
                        assertTrue("new exact offer must be extracted",reply.rows.any{it.postId=="550000000000096"&&it.area==68.0&&it.price==680000.0})
                    }
                    if(colloquial){
                        val row=reply.rows.single{it.postId=="550000000000091"}
                        assertEquals(365400.0,row.price!!,0.0);assertEquals(63.0,row.area!!,0.0);assertEquals(2,row.rooms)
                        assertEquals("DERIVED_FROM_PRICE_PER_M2",row.priceSource);assertTrue(DesktopSummary.eligible(row))
                        assertNull(row.street);assertNull(row.district)
                        val panel=OffersPanel(context,{},{})
                        panel.showRows(reply.rows)
                        val price=panel.findViewWithTag<android.widget.TextView>("poc.offer.price.${row.postId}")
                        assertNotNull(price);assertTrue(price.text.toString().startsWith("Cena wyliczona z ceny za m²:"))
                        val report=DesktopSummary.create("DONE",trial.requests,reply).encode()
                        assertFalse(report.contains("365400"));assertFalse(report.contains(row.postId));panel.showRows(emptyList())
                    }
                    if(fullMessage){
                        assertEquals(1,reply.stats.getValue("textExpandArmed"));assertEquals(1,reply.stats.getValue("dataPrice"));assertEquals(1,reply.stats.getValue("dataArea"));assertEquals(1,reply.stats.getValue("dataRooms"));assertEquals(1,reply.stats.getValue("dataLocation"));assertTrue(reply.stats.getValue("textRecognized")>=1)
                        assertEquals(1,reply.stats.getValue("textExpandAttempts"));assertEquals(1,reply.stats.getValue("textExpanded"))
                        val row=reply.rows.single{it.postId=="550000000000091"};assertEquals(319000.0,row.price!!,0.0);assertEquals(42.0,row.area!!,0.0);assertEquals(2,row.rooms);assertEquals("Testowa 12",row.street);assertTrue(DesktopSummary.eligible(row))
                    }
                    if(baseline){
                        assertTrue("baseline must really scroll throughout the window",reply.stats.getValue("scrollMoves")>=(if(fastScroll)45 else 25))
                        assertTrue(reply.stats.getValue("scrollElapsedMs") in 29000..30000)
                        assertTrue("offer extraction stays active",reply.rows.isNotEmpty())
                        for(key in listOf("viewportGranted","viewportReady","nativeRequests","scrollNativeSteps","photoPreviewFrames","photoPreviews"))assertEquals("baseline leaked $key",0,reply.stats.getValue(key))
                        assertEquals(0,images.count);assertTrue(channel.lastViewportCaptureCounts.isEmpty());return@withContext
                    }
                    assertEquals("viewport handshake must complete",1,reply.stats.getValue("viewportReady"))
                    assertTrue("official wheel request absent",reply.stats.getValue("scrollNativeSteps")>0)
                    if(deep)assertTrue("native request ACK is not motion proof",reply.stats.getValue("scrollNativeMoves")>0)
                    else assertTrue("wheel must unlock actual further progress beyond finite initial range",reply.stats.getValue("scrollMoves")>4)
                    assertTrue("wheel must load a NEW exact offer",reply.rows.any{it.postId=="550000000000096"&&it.price==680000.0&&it.area==68.0})
                    if(delegated){assertTrue("ancestor hit must lead to real native movement",reply.stats.getValue("scrollNativeMoves")>0);assertEquals("pointer delegation must not remove photos",2,images.count)}
                    if(marginOnly){assertTrue("central frame must be detected and excluded",reply.stats.getValue("pointFrame")>0);assertTrue("safe margin must produce real movement",reply.stats.getValue("scrollNativeMoves")>0);return@withContext}
                    if(cachedFeed){assertEquals("cross-post cards cannot become own group offers",false,reply.rows.any{it.postId in setOf("550000000000091","550000000000092")});assertEquals(0,images.count);return@withContext}
                    if(cssPhotos){assertTrue(reply.stats.getValue("photoRawCss")>0);assertTrue(reply.stats.getValue("photoSelected")>=2)}
                    if(documentPhotos){assertTrue("document images must be independently bound",reply.stats.getValue("photoDocumentBound")>=2);assertTrue("document crops must be selected",reply.stats.getValue("photoDocumentSelected")>=2)}
                    if(svgPhotos)assertTrue("SVG root selection must be observed",reply.stats.getValue("photoSvgBounds")>0)
                    val thumbs=images.rows("550000000000091")
                    if(networkOnly){assertTrue("network identity required",reply.stats.getValue("network")>0);assertEquals("initial post must not be invented from DOM", "NETWORK",reply.rows.single{it.postId=="550000000000091"}.layer)}
                    assertEquals("actual rendered image crops missing",2,thumbs.size)
                    assertTrue(thumbs.all{it.width<=192&&it.height<=144})
                    val colors=thumbs.map{it.getPixel(it.width/2,it.height/2)}
                    assertTrue("red picture missing",colors.any{android.graphics.Color.red(it)>200&&android.graphics.Color.green(it)<40})
                    assertTrue("green picture missing",colors.any{android.graphics.Color.green(it)>200&&android.graphics.Color.red(it)<40})
                    val row=reply.rows.single{it.postId=="550000000000091"}
                    assertTrue("own post text must survive the post wrapper and remain eligible",DesktopSummary.eligible(row))
                    assertEquals(319000.0,row.price!!,0.0);assertEquals(42.0,row.area!!,0.0)
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

    @Test fun nativeProbeDistinguishesDialogFocusAndRecoversWithoutInputOrCapture(){
        ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->
            var host:GeckoTestHostActivity?=null;var dialog:android.app.AlertDialog?=null
            var bridge:DesktopViewportBridge?=null;val nonce=UUID.randomUUID().toString();val images=DesktopThumbnails()
            scenario.onActivity{host=it;bridge=DesktopViewportBridge(it.geckoView,nonce,images,{true});dialog=android.app.AlertDialog.Builder(it).setMessage("Local consent fixture").create();dialog!!.show()}
            try{
                runBlocking{withTimeout(3000){while(true){var focused=true;scenario.onActivity{focused=it.geckoView.hasWindowFocus()};if(!focused)break;delay(50)}}}
                scenario.onActivity{
                    var ack:org.json.JSONObject?=null;bridge!!.handle(org.json.JSONObject().put("type","desktopViewportRequest").put("nonce",nonce).put("requestId",UUID.randomUUID().toString()).put("action","probe")){ack=it}
                    assertFalse(ack!!.getBoolean("accepted"));assertEquals(3,ack!!.getInt("count"));assertEquals(0,images.count);dialog!!.dismiss()
                }
                runBlocking{withTimeout(3000){while(true){var focused=false;scenario.onActivity{focused=it.geckoView.hasWindowFocus()};if(focused)break;delay(50)}}}
                scenario.onActivity{
                    var ack:org.json.JSONObject?=null;bridge!!.handle(org.json.JSONObject().put("type","desktopViewportRequest").put("nonce",nonce).put("requestId",UUID.randomUUID().toString()).put("action","probe")){ack=it}
                    assertTrue(ack!!.getBoolean("accepted"));assertEquals(0,ack!!.getInt("count"));assertEquals(0,images.count)
                }
            }finally{scenario.onActivity{dialog?.dismiss();bridge?.close();images.clear()}}
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
                    assertTrue(texts(oldCards!!).contains(id));assertTrue(texts(oldCards!!).contains(missing.postId))
                    assertNotNull(root.findViewWithTag<android.view.View>("poc.review.link.${missing.postId}"))
                    assertNull(root.findViewWithTag<android.view.View>("poc.offer.card.${missing.postId}"))
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
