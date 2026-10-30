package pl.jakubokruszek.flipwatcher.geckopoc

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.geckoview.GeckoSession

@RunWith(AndroidJUnit4::class)
class SinglePhotoInstrumentedTest {
 @Test fun explicitSingleOfferUsesOneWorkerAndLeavesOtherRowsUntouched(){
  ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->
   var host:GeckoTestHostActivity?=null;scenario.onActivity{host=it}
   runBlocking{withTimeout(45000){withContext(Dispatchers.Main){
    val a="550000000000091";val b="550000000000092"
    fun row(id:String)=DesktopRow(id,"https://www.facebook.com/groups/$FIXTURE_GROUP_ID/posts/$id/","DOM",319000.0,"EXPLICIT_TOTAL",42.0,2,null,null,null,"SELL_PROPERTY",true,0)
    val path="/groups/$FIXTURE_GROUP_ID/posts/$b/"
    val server=LoopbackFixtureServer(pages=mapOf(path to "single-photo")){name->when(name){
     "fixtures/home.html"->"<!doctype html><title>Original group</title><p>Original</p>"
     "fixtures/single-photo.html"->"<!doctype html><title>Single exact post</title><article role=article><a href='https://www.facebook.com/groups/$FIXTURE_GROUP_ID/posts/$b/'>Post</a><div data-ad-preview=message>Sprzedam mieszkanie 42m2 za 319000 zł, 2 pokoje.</div></article>"
     else->null
    }}
    val original=GeckoSession();val source=CollectorChannel(original,fixtureMode=true)
    try{
     source.attach(GeckoHost.collectorExtension(host!!));original.open(GeckoHost.runtime(host!!));host!!.geckoView.setSession(original);original.setActive(true)
     original.loadUri(server.url("/groups/$FIXTURE_GROUP_ID/","home"));assertTrue(source.awaitPort(15000));delay(300)
     val bound=mutableListOf<String>()
     val out=ReviewDataRunner.run(host!!.geckoView,original,listOf(row(a),row(b)),true,{true},fixtureOrigin="http://127.0.0.1:${server.port}",selectedPostId=b,onBoundPost={channel,r,current,live->
      bound+=r.postId;val images=DesktopThumbnails()
      try{assertTrue(channel.reviewImages(r,current,host!!.geckoView,images,true,group=FIXTURE_GROUP_ID,alive=live));assertEquals("NO_IMAGE",channel.reviewImageOutcome);assertEquals(0,channel.reviewImageDetails.getValue("rawImg"));assertEquals(0,channel.reviewImageDetails.getValue("qualified"))}finally{images.clear()}
     })
     assertEquals(out.summary.report(),"DONE",out.summary.reason);assertEquals(1,out.summary.opened);assertEquals(listOf(b),bound)
     assertEquals(row(a),out.rows.first{it.postId==a});assertEquals(2,out.rows.size)
    }finally{source.close();if(host!!.geckoView.session!=null)host!!.geckoView.releaseSession();original.close();server.close()}
   }}}
  }
 }
}
