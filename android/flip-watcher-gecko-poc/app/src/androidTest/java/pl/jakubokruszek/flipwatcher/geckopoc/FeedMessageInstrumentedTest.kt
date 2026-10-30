package pl.jakubokruszek.flipwatcher.geckopoc

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.geckoview.*
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class FeedMessageInstrumentedTest{
 @Test fun storyMessagesFromOperatorExamplesFillFeedFieldsWithoutCommentsQuotesOrHiddenValues(){
  ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->var host:GeckoTestHostActivity?=null;scenario.onActivity{host=it}
   runBlocking{withTimeout(50_000){withContext(Dispatchers.Main){
    val group=FIXTURE_GROUP_ID;val groupPath="/groups/$group/"
    fun card(id:String,text:String)="""<article role="article"><a href="https://www.facebook.com/groups/$group/posts/$id/">Post</a><div data-ad-rendering-role="story_message">$text<div role="comment">Cena 9000000 zł, powierzchnia 999m2, 9 pokoje</div><blockquote>Sprzedam za 9999999 zł</blockquote><form><input value="SECRET_DRAFT"><textarea>9999999 zł</textarea></form><span hidden>9999999 zł</span><span style="display:none">9999999 zł</span><div role="button">Zobacz więcej</div></div></article>"""
    val body="<!doctype html><meta name=viewport content='width=device-width'><title>Operator message fixtures</title>"+
     card("550000000000081","Na sprzedaż 3 pokoje z osobną kuchnią 57m2 na Bałutach!<div>Inflancka</div><div>Cena 379 000 zł (6649 zł/m2)</div><div>Piętro 2/10</div><div>Do remontu</div>")+
     card("550000000000082","Na sprzedaż kawalerka inwestycyjna z garażem.<div>26,32m2</div><div>2 piętro z windą</div><div>balkon</div><div>379 000 zł</div>")+
     card("550000000000083","Sprzedam 3-pokojowe M6 65m2 + Balkon w Centrum Łodzi!!<div>64,98m² + Balkon</div><div>Pełen Rozkład: 3 pokoje, oddzielna Kuchnia, Łazienka i osobne WC</div>")
    val server=LoopbackFixtureServer{if(it=="fixtures/feed-messages.html")body else null};val target=server.url(groupPath,"feed-messages")
    val session=GeckoSession(GeckoSessionSettings.Builder().build());var gate:DesktopTrial?=null;var current:String?=null;var ready=false
    val channel=CollectorChannel(session,fixtureMode=true,onDesktopStop={gate?.stop("CONTEXT")})
    session.navigationDelegate=object:GeckoSession.NavigationDelegate{
     override fun onLoadRequest(s:GeckoSession,q:GeckoSession.NavigationDelegate.LoadRequest)=GeckoResult.fromValue(if(if(gate==null)q.uri==target else gate!!.request(q.uri,q.isRedirect,q.target==GeckoSession.NavigationDelegate.TARGET_WINDOW_NEW,q.hasUserGesture))AllowOrDeny.ALLOW else AllowOrDeny.DENY)
     override fun onLocationChange(s:GeckoSession,u:String?,p:MutableList<GeckoSession.PermissionDelegate.ContentPermission>,gesture:Boolean){current=u;if(gate?.active==true)gate!!.location(u)}
    }
    session.progressDelegate=object:GeckoSession.ProgressDelegate{override fun onPageStart(s:GeckoSession,u:String){ready=false};override fun onPageStop(s:GeckoSession,success:Boolean){ready=success}}
    try{
     channel.attach(GeckoHost.collectorExtension(host!!));session.open(GeckoHost.runtime(host!!));host!!.geckoView.setSession(session);session.setActive(true);session.setFocused(true);host!!.geckoView.requestFocus()
     session.loadUri(target);assertTrue(channel.awaitPort(15000));withTimeout(10000){while(!ready||current!=target)delay(50)}
     val trial=DesktopTrial(target,{android.os.SystemClock.elapsedRealtime()},fixture=true);gate=trial;assertTrue(trial.begin(true))
     val result=DesktopSessionPreview.run(session,channel,trial,UUID.randomUUID().toString(),target,{current},pageReady={ready},fixture=true,windowMs=15000)
     assertEquals("DONE",result.reason);val rows=result.reply!!.rows;assertEquals(3,rows.size)
     val first=rows.single{it.postId=="550000000000081"};assertEquals(379000.0,first.price!!,0.0);assertEquals(57.0,first.area!!,0.0);assertEquals(3,first.rooms)
     val second=rows.single{it.postId=="550000000000082"};assertEquals(379000.0,second.price!!,0.0);assertEquals(26.32,second.area!!,0.0)
     val third=rows.single{it.postId=="550000000000083"};assertNull(third.price);assertEquals(64.98,third.area!!,0.0);assertEquals(3,third.rooms)
     assertTrue(rows.all{DesktopSummary.eligible(it)});assertEquals(3,result.reply!!.stats.getValue("dataArea"));assertFalse(rows.toString().contains("SECRET"))
    }finally{channel.close();runCatching{host!!.geckoView.releaseSession()};session.close();server.close()}
   }}}
  }
 }
}
