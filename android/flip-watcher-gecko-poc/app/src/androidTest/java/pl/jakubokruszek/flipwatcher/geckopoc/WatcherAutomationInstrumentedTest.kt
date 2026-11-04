package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WatcherAutomationInstrumentedTest {
    private val context:Context=ApplicationProvider.getApplicationContext()
    private val device="12345678-1234-1234-1234-123456789012"
    private val group=WatcherGroups.configured.first()
    private fun photo(id:String="550000000000091"):SavedPhoto {
        val bitmap=android.graphics.Bitmap.createBitmap(192,144,android.graphics.Bitmap.Config.ARGB_8888)
        val canvas=android.graphics.Canvas(bitmap);canvas.drawColor(android.graphics.Color.WHITE)
        canvas.drawText("SPRZEDAM 42 m2",8f,60f,android.graphics.Paint().apply{textSize=16f})
        return try{ResultArchive.photo(id,0,false,bitmap)}finally{bitmap.recycle()}
    }
    private fun result(price:Double=430000.0)=SavedResult(System.currentTimeMillis(),listOf(
        DesktopRow("550000000000091",group.url+"posts/550000000000091/","DOM",price,"EXPLICIT_TOTAL",42.0,2,"Bałuty",null,null,"SELL_PROPERTY",true,0)
    ),emptyList(),listOf(photo()))
    @Test fun boundedPostTextRequiresOptInAndExactRowIdentityAndSurvivesFrozenQueue(){
        val row=result().rows.single();val nonce=java.util.UUID.randomUUID().toString()
        val stats=DesktopProtocol.emptyStats().toMutableMap().apply{put("candidates",1);put("verified",1)}
        fun reply(id:String=row.postId,text:String="NA SPRZEDAŻ:\n339.000 do negocjacji")=org.json.JSONObject().put("type","desktopPreviewResult").put("nonce",nonce).put("status","OK").put("reason","DONE").put("rows",org.json.JSONArray().put(SavedResultCodec.row(row))).put("stats",org.json.JSONObject(stats)).put("postTexts",org.json.JSONArray().put(org.json.JSONObject().put("postId",id).put("permalink",row.permalink).put("text",text)))
        assertNull(DesktopProtocol.parse(reply(),nonce,group.id))
        val valid=checkNotNull(DesktopProtocol.parse(reply(),nonce,group.id,true));assertTrue(valid.postTexts.getValue(row.postId).contains("339.000"))
        assertNull(DesktopProtocol.parse(reply("999999"),nonce,group.id,true))
        assertNull(DesktopProtocol.parse(reply(text="x".repeat(12001)),nonce,group.id,true))
        assertNull(DesktopProtocol.parse(reply(text="bad\u0000text"),nonce,group.id,true))
        context.deleteDatabase("watcher-outbox-v1.db")
        try{
            val frozen=WatcherOutbox(context).use{q->q.enqueue(device,group,result().copy(postTexts=valid.postTexts));checkNotNull(q.next(device,Long.MAX_VALUE))}
            WatcherOutbox(context).use{q->val reopened=checkNotNull(q.next(device,Long.MAX_VALUE));assertEquals(frozen.id,reopened.id);assertEquals(frozen.body,reopened.body);val body=org.json.JSONObject(reopened.body);assertEquals(2,body.getInt("version"));assertEquals(valid.postTexts.getValue(row.postId),body.getString("postText"))}
        }finally{context.deleteDatabase("watcher-outbox-v1.db")}
    }
    @Test fun fiftyBackgroundThumbnailOwnersFitWithoutRelaxingManualOrOcrMemoryBounds(){
        val background=DesktopThumbnails(50);val manual=DesktopThumbnails()
        try{
            for(i in 0..50){val id=(550000000000100L+i).toString()
                assertEquals(i<50,background.put(id,0,android.graphics.Bitmap.createBitmap(10,10,android.graphics.Bitmap.Config.ARGB_8888)))
                assertEquals(i<20,manual.put(id,0,android.graphics.Bitmap.createBitmap(10,10,android.graphics.Bitmap.Config.ARGB_8888)))
            }
            assertEquals(50,background.count);assertEquals(20,manual.count);assertTrue(background.ocrBytes<=24*1024*1024)
        }finally{background.clear();manual.clear()}
    }
    @Test fun fiftyBackgroundRowsStayBoundedAndEachFrozenPacketHasItsOwnDescription(){
        context.deleteDatabase("watcher-outbox-v1.db")
        try{
            val base=result();val rows=(0 until 50).map{i->val id=(550000000000100L+i).toString();base.rows.single().copy(postId=id,permalink=group.url+"posts/$id/")}
            val photos=rows.map{base.photos.single().copy(postId=it.postId)}
            val texts=rows.associate{it.postId to "Opis własnego posta ${it.postId}"}
            assertNull(SavedResultCodec.rows(org.json.JSONArray(rows.map(SavedResultCodec::row)),group.id))
            assertEquals(rows,SavedResultCodec.rows(org.json.JSONArray(rows.map(SavedResultCodec::row)),group.id,true))
            WatcherOutbox(context).use{q->
                q.enqueue(device,group,base.copy(rows=rows,photos=photos,postTexts=texts))
                val seen=mutableSetOf<String>()
                repeat(50){val item=checkNotNull(q.next(device,Long.MAX_VALUE));val body=org.json.JSONObject(item.body);val id=body.getJSONObject("row").getString("postId");assertTrue(seen.add(id));assertEquals(texts[id],body.getString("postText"));q.acknowledge(item.id,"receipt-$id")}
                assertNull(q.next(device,Long.MAX_VALUE));assertEquals(50,seen.size)
            }
        }finally{context.deleteDatabase("watcher-outbox-v1.db")}
    }
    @Test fun encryptedQueueSurvivesReopenLostReceiptAndRepeatedScan() {
        context.deleteDatabase("watcher-outbox-v1.db")
        val first=WatcherOutbox(context).use{q->q.enqueue(device,group,result());checkNotNull(q.next(device,Long.MAX_VALUE))}
        val replay=WatcherOutbox(context).use{q->q.enqueue(device,group,result());checkNotNull(q.next(device,Long.MAX_VALUE))}
        assertEquals(first.id,replay.id);assertEquals(first.body,replay.body)
        WatcherOutbox(context).use{q->q.acknowledge(first.id,"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")}
        WatcherOutbox(context).use{q->
            q.enqueue(device,group,result());assertNull(q.next(device,Long.MAX_VALUE))
            q.enqueue(device,group,result(440000.0));val changed=checkNotNull(q.next(device,Long.MAX_VALUE));assertNotEquals(first.id,changed.id)
            q.defer(changed,true);assertNull(q.next(device,Long.MAX_VALUE));q.retry();assertEquals(changed.id,q.next(device,Long.MAX_VALUE)?.id)
            q.readableDatabase.rawQuery("SELECT body FROM outbox WHERE state='pending'",null).use{c->assertTrue(c.moveToFirst());assertFalse(String(c.getBlob(0),Charsets.UTF_8).contains("facebook.com"))}
            q.completeScan("2026-10-30/7",group.id);assertTrue(q.scanned("2026-10-30/7",group.id));assertFalse(q.scanned("2026-10-30/15",group.id))
        }
        context.deleteDatabase("watcher-outbox-v1.db")
    }
    @Test fun holdMissingPhotoAndNonSaleWithoutDestroyingSnapshots() {
        context.deleteDatabase("watcher-outbox-v1.db")
        try {WatcherOutbox(context).use{q->
            q.enqueue(device,group,result().copy(photos=emptyList()));assertNull(q.next(device,Long.MAX_VALUE))
            val rental=result().let{it.copy(rows=it.rows.map{r->r.copy(intent="RENT_OFFER")})}
            q.enqueue(device,group,rental);assertNull(q.next(device,Long.MAX_VALUE))
            assertTrue(q.status().contains("quality_hold: 2"))
            q.enqueue(device,group,result());val valid=checkNotNull(q.next(device,Long.MAX_VALUE))
            assertEquals(1,org.json.JSONObject(valid.body).getJSONArray("photos").length())
        }}finally{context.deleteDatabase("watcher-outbox-v1.db")}
    }
    @Test fun savedDateCleanupPreservesUnknownDatesAndReceiptsAndDoesNotResurrectPosts() {
        context.deleteDatabase("watcher-outbox-v1.db")
        val before=System.currentTimeMillis()-30L*86400000
        try {WatcherOutbox(context).use{q->
            q.enqueue(device,group,result().copy(savedAt=before-1))
            val old=checkNotNull(q.next(device,Long.MAX_VALUE));q.acknowledge(old.id,"ack-keep")
            val fresh=result().let{r->val id="550000000000092";r.copy(savedAt=before,rows=r.rows.map{it.copy(postId=id,permalink=group.url+"posts/$id/")},photos=listOf(photo(id)))}
            q.enqueue(device,group,fresh)
            val unknown=result().let{r->val id="550000000000093";r.copy(rows=r.rows.map{it.copy(postId=id,permalink=group.url+"posts/$id/")},photos=listOf(photo(id)))}
            q.enqueue(device,group,unknown)
            q.writableDatabase.execSQL("UPDATE outbox SET saved_at=NULL WHERE post='550000000000093'")
            val preview=q.cleanupPreview(group.id,before)
            assertEquals(1,preview.rows);assertEquals(1,preview.unknownDate);assertEquals(0,preview.pending)
            q.cleanup(group.id,before,preview)
            q.enqueue(device,group,result(440000.0));q.retry()
            q.readableDatabase.rawQuery("SELECT state,receipt,length(body) FROM outbox WHERE id=?",arrayOf(old.id)).use{c->assertTrue(c.moveToFirst());assertEquals("deleted",c.getString(0));assertEquals("ack-keep",c.getString(1));assertEquals(0,c.getInt(2))}
            assertEquals(0,q.cleanupPreview(group.id,before).rows)
            assertEquals(1,q.cleanupPreview(group.id,before).unknownDate)
            q.readableDatabase.rawQuery("SELECT COUNT(*) FROM outbox",null).use{c->assertTrue(c.moveToFirst());assertEquals(3,c.getInt(0))}
        }}finally{context.deleteDatabase("watcher-outbox-v1.db")}
    }
    @Test fun versionOneMigrationPreservesFrozenBytesAndLeavesUnknownDatesUnknown(){
        context.deleteDatabase("watcher-outbox-v1.db")
        try {
            val old=WatcherOutbox(context).use{q->
                q.enqueue(device,group,result());val item=checkNotNull(q.next(device,Long.MAX_VALUE));q.acknowledge(item.id,"ack-before-upgrade")
                q.writableDatabase.execSQL("DROP TABLE removed_posts")
                for(column in listOf("source","post","saved_at"))q.writableDatabase.execSQL("ALTER TABLE outbox DROP COLUMN $column")
                q.writableDatabase.version=1;item
            }
            WatcherOutbox(context).use{q->
                val migrated=checkNotNull(q.next(device,Long.MAX_VALUE));assertEquals(old.id,migrated.id);assertEquals(old.body,migrated.body)
                q.readableDatabase.rawQuery("SELECT receipt FROM outbox WHERE id=?",arrayOf(old.id)).use{c->assertTrue(c.moveToFirst());assertEquals("ack-before-upgrade",c.getString(0))}
                val preview=q.cleanupPreview(group.id,System.currentTimeMillis());assertEquals(0,preview.rows);assertEquals(1,preview.unknownDate)
            }
        }finally{context.deleteDatabase("watcher-outbox-v1.db")}
    }
    @Test fun actualBackgroundRendererReadsExactRowsAndBoundPhotoWithoutActivity()=runBlocking {
        val path="/groups/$FIXTURE_GROUP_ID/"
        val server=LoopbackFixtureServer(redirects=mapOf(path to path.trimEnd('/')),pages=mapOf(path.trimEnd('/') to "desktop-viewport")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
        try {
            val saved=BackgroundWatcherScan(context).runFixture("http://127.0.0.1:${server.port}$path"){true}
            assertTrue(saved.rows.isNotEmpty())
            assertTrue(saved.rows.all{it.permalink.startsWith("https://www.facebook.com/groups/$FIXTURE_GROUP_ID/posts/")})
            assertTrue("Background photos must be captured, not inferred from row counters",saved.photos.isNotEmpty())
            assertTrue(saved.photos.all{p->saved.rows.any{it.postId==p.postId}&&p.jpeg.isNotEmpty()})
        }finally{server.close()}
    }
    @Test fun backgroundCollectsColouredPostAndAutomaticallyReadsImageOnlyOffer()=runBlocking {
        val path="/groups/$FIXTURE_GROUP_ID/"
        val server=LoopbackFixtureServer(pages=mapOf(path to "desktop-text-posters")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
        try {
            val saved=BackgroundWatcherScan(context).runFixture("http://127.0.0.1:${server.port}$path"){true}
            val retkinia=checkNotNull(saved.rows.find{it.postId=="1655103482946825"})
            assertEquals(339000.0,retkinia.price);assertEquals(42.42,retkinia.area);assertEquals(2,retkinia.rooms)
            val sourceText=checkNotNull(saved.postTexts[retkinia.postId]);assertTrue(sourceText.contains("339.000 do negocjacji"));assertFalse(sourceText.contains("FOREIGN COMMENT"))
            for(id in listOf("1655103482946823","1655103482946824")){
                val row=checkNotNull(saved.rows.find{it.postId==id})
                assertEquals("SELL_PROPERTY",row.intent);assertEquals(368000.0,row.price);assertEquals(62.4,row.area);assertNull(row.rooms)
                assertNull("Both own message graphics and image-only ads must have actual stored pixels",OfferQuality.reason(row,saved.photos.count{it.postId==id}))
            }
        }finally{server.close()}
    }
    @Test fun diagnosticsSurviveVersionTwoUpgradeWithoutReplayingBusinessBodies(){
        context.deleteDatabase("watcher-outbox-v1.db")
        try{
            val frozen=WatcherOutbox(context).use{q->q.enqueue(device,group,result());val item=checkNotNull(q.next(device,Long.MAX_VALUE));q.acknowledge(item.id,"keep-receipt");q.writableDatabase.execSQL("DROP TABLE capture_reports");q.writableDatabase.version=2;item}
            val slot=WatcherCaptureReport.cycle("2026-11-04/20")
            val stats=DesktopProtocol.emptyStats().toMutableMap().apply{put("pageVisible",1);put("scrollMoves",5)}
            val value=result().copy(captureStats=stats)
            assertEquals("",WatcherCaptureReport.issue(value));assertEquals("SALE_PHOTO_MISSING",WatcherCaptureReport.issue(value.copy(photos=emptyList())))
            val unknown=value.copy(rows=value.rows.map{it.copy(intent="UNKNOWN",qualification="NO_TEXT",usable=false)},photos=emptyList())
            assertEquals("SALE_PHOTO_MISSING",WatcherCaptureReport.issue(unknown))
            assertEquals("PAGE_HIDDEN",WatcherCaptureReport.issue(value.copy(captureStats=stats+mapOf("pageVisible" to 0))))
            val report=WatcherCaptureReport.create(context,slot,java.util.UUID.randomUUID().toString(),group,value,"")
            WatcherOutbox(context).use{q->
                assertNull("Schema-only upgrade must preserve sent state",q.next(device,Long.MAX_VALUE))
                q.readableDatabase.rawQuery("SELECT id,receipt FROM outbox",null).use{assertTrue(it.moveToFirst());assertEquals(frozen.id,it.getString(0));assertEquals("keep-receipt",it.getString(1))}
                q.report(device,slot,group.id,report);q.completeScan("2026-11-04/20",group.id);assertFalse(q.scanned(slot,group.id))
                assertFalse(report.toString().contains("SPRZEDAM"));assertFalse(report.toString().contains("jpeg"))
                q.readableDatabase.rawQuery("SELECT body FROM capture_reports",null).use{assertTrue(it.moveToFirst());assertFalse(String(it.getBlob(0)).contains(group.id))}
            }
            WatcherOutbox(context).use{q->assertEquals(report.toString(),q.nextReport(device)?.body);assertEquals(1,q.cycleReports(slot).size);q.reportSent(report.getString("batchId"));assertNull(q.nextReport(device));assertTrue(WatcherCaptureReport.summary(q.cycleReports(slot)).contains("posty 1"))}
        }finally{context.deleteDatabase("watcher-outbox-v1.db")}
    }
    @Test fun colouredPosterBackgroundCaptureWorksWithDisplayAsleep()=runBlocking {
        val instrumentation=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        val power=context.getSystemService(android.os.PowerManager::class.java)
        @Suppress("DEPRECATION") val wake=power.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK,"flipwatcher:fixture").apply{acquire(300_000)}
        val path="/groups/$FIXTURE_GROUP_ID/"
        val server=LoopbackFixtureServer(pages=mapOf(path to "desktop-text-posters")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
        fun shell(command:String){instrumentation.uiAutomation.executeShellCommand(command).use{android.os.ParcelFileDescriptor.AutoCloseInputStream(it).use{input->input.readBytes()}}}
        try{
            shell("input keyevent KEYCODE_HOME");shell("input keyevent KEYCODE_SLEEP");kotlinx.coroutines.delay(1000)
            assertFalse("Fixture must genuinely run with the display asleep",power.isInteractive)
            val saved=BackgroundWatcherScan(context).runFixture("http://127.0.0.1:${server.port}$path"){true}
            val id="1655103482946823";assertTrue(saved.photos.any{it.postId==id})
            assertEquals(368000.0,saved.rows.find{it.postId==id}?.price)
            assertEquals(1,saved.captureStats["pageVisible"])
        }finally{shell("input keyevent KEYCODE_WAKEUP");shell("wm dismiss-keyguard");if(wake.isHeld)wake.release();server.close()}
    }
    @Test fun calendarIgnoresOldRevisionAndManualCycleRechecksWhileDegradedReadGetsExactlyOneRetry()=runBlocking {
        context.deleteDatabase("watcher-outbox-v1.db")
        val prefs=WatcherAutomation.preferences(context);val backup=prefs.all.toMap()
        val visible=WatcherAutomation.uiVisible;val oldGroups=WatcherGroups.active.toList()
        val catalog=context.getSharedPreferences("gecko_poc",Context.MODE_PRIVATE);val oldCatalog=catalog.getString("watcher_active_groups",null)
        val selected=WatcherGroups.configured.take(2);assertEquals(2,selected.size)
        val window=AutomationPolicy.current(java.time.Instant.now(),java.time.ZoneId.systemDefault(),WatcherAutomation.schedule(context))
        val credentials=WatcherLink.Credentials(device,"fixture-unused-credential")
        var calls=0;var degraded=false;var reports=0
        val factory=object:androidx.work.WorkerFactory(){
            override fun createWorker(appContext:Context,name:String,parameters:androidx.work.WorkerParameters):androidx.work.ListenableWorker =
                object:WatcherAutomationWorker(appContext,parameters){
                    override fun credentials(context:Context)=credentials
                    override fun groups(credentials:WatcherLink.Credentials)=selected
                    override fun send(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item)="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
                    override fun sendReport(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item){reports++;assertFalse(item.body.contains("jpeg"))}
                    override suspend fun scan(group:WatcherGroup,progress:(String)->Unit):SavedResult {
                        calls++;val value=result();val row=value.rows.single().copy(permalink=group.url+"posts/"+value.rows.single().postId+"/")
                        return value.copy(rows=listOf(row),photos=if(degraded)emptyList()else value.photos,captureStats=DesktopProtocol.emptyStats()+mapOf("pageVisible" to 1,"scrollMoves" to 1))
                    }
                }
        }
        fun worker()=androidx.work.testing.TestListenableWorkerBuilder<WatcherAutomationWorker>(context).setWorkerFactory(factory).build()
        try{
            prefs.edit().putBoolean("enabled",true).putLong("schedule_since",0).putString("completed_slot",window.key).remove("requested_scan").commit();WatcherAutomation.uiVisible=false
            WatcherOutbox(context).use{q->selected.forEach{q.completeScan(window.key,it.id)}}
            assertEquals(androidx.work.ListenableWorker.Result.success(),worker().doWork());assertEquals(2,calls);assertEquals("DONE",WatcherScanStatus.read(context).phase)
            assertEquals(2,WatcherScanStatus.read(context).done);assertEquals(2,reports)
            worker().doWork();assertEquals("Calendar must reuse only this revision's valid completion",2,calls)
            prefs.edit().putString("requested_scan",java.util.UUID.randomUUID().toString()).commit()
            worker().doWork();assertEquals("Manual request must re-read both sources",4,calls)
            degraded=true;prefs.edit().putString("requested_scan",java.util.UUID.randomUUID().toString()).commit()
            assertEquals(androidx.work.ListenableWorker.Result.retry(),worker().doWork());assertEquals(6,calls)
            assertEquals(androidx.work.ListenableWorker.Result.success(),worker().doWork());assertEquals(8,calls)
            assertEquals("PARTIAL",WatcherScanStatus.read(context).phase);assertEquals("CAPTURE_PARTIAL",WatcherScanStatus.read(context).reason)
            worker().doWork();assertEquals("Degraded sources must not spin forever",8,calls)
        }finally{
            WatcherAutomation.configure(context,false)
            val edit=prefs.edit().clear();for((k,v)in backup)when(v){is String->edit.putString(k,v);is Boolean->edit.putBoolean(k,v);is Long->edit.putLong(k,v);is Int->edit.putInt(k,v)};edit.commit()
            WatcherAutomation.uiVisible=visible;WatcherGroups.setActive(oldGroups);catalog.edit().putString("watcher_active_groups",oldCatalog).commit();context.deleteDatabase("watcher-outbox-v1.db")
        }
    }
    @Test fun workerDrains31QueuedOffersWhileUiVisibleAndReplaysLostReceiptWithoutDuplicates()=runBlocking {
        context.deleteDatabase("watcher-outbox-v1.db")
        val prefs=WatcherAutomation.preferences(context)
        val oldEnabled=WatcherAutomation.enabled(context);val oldVisible=WatcherAutomation.uiVisible
        val oldCompleted=prefs.getString("completed_slot",null)
        val catalogPrefs=context.getSharedPreferences("gecko_poc",Context.MODE_PRIVATE)
        val oldCatalog=catalogPrefs.getString("watcher_active_groups",null)
        val oldGroups=WatcherGroups.active.toList()
        prefs.edit().putBoolean("enabled",true).remove("completed_slot").commit();WatcherAutomation.uiVisible=false
        val accepted=linkedMapOf<String,String>();var calls=0;var loseReceipt=true;var foregroundAttempts=0
        val credentials=WatcherLink.Credentials(device,"synthetic-credential-unused-over-network")
        val factory=object:androidx.work.WorkerFactory(){
            override fun createWorker(appContext:Context,name:String,parameters:androidx.work.WorkerParameters):androidx.work.ListenableWorker =
                object:WatcherAutomationWorker(appContext,parameters){
                    override fun credentials(context:Context)=credentials
                    override fun groups(credentials:WatcherLink.Credentials):List<WatcherGroup> { check(!WatcherAutomation.uiVisible){"Browser must not be used while UI is visible"};return emptyList() }
                    override fun send(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item):String {
                        calls++
                        val old=accepted.putIfAbsent(item.id,item.body)
                        if(old!=null)assertEquals("Retries must preserve the exact frozen body",old,item.body)
                        if(loseReceipt){loseReceipt=false;throw java.io.IOException("Synthetic lost receipt")}
                        return "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
                    }
                }
        }
        fun worker()=androidx.work.testing.TestListenableWorkerBuilder<WatcherAutomationWorker>(context).setWorkerFactory(factory)
            .setForegroundUpdater{_,_,_->
                foregroundAttempts++
                androidx.concurrent.futures.CallbackToFutureAdapter.getFuture<Void>{reply->
                    reply.setException(android.app.ForegroundServiceStartNotAllowedException("Synthetic background start denial"));"denied"
                }
            }.build()
        try {
            WatcherOutbox(context).use { q ->
                repeat(31){index->val post=(550000000000100L+index).toString()
                    val row=result().rows.single().copy(postId=post,permalink=group.url+"posts/$post/")
                    q.enqueue(device,group,result().copy(rows=listOf(row),photos=listOf(photo(post))))
                }
            }
            assertEquals(androidx.work.ListenableWorker.Result.success(),worker().doWork())
            assertEquals(1,accepted.size)
            WatcherOutbox(context).use{it.retry()}
            WatcherAutomation.uiVisible=true
            assertEquals(androidx.work.ListenableWorker.Result.success(),worker().doWork())
            WatcherOutbox(context).use{q->assertNull(q.next(device,Long.MAX_VALUE));assertTrue(q.status().contains("sent: 31"))}
            assertEquals(31,accepted.size);assertEquals(32,calls)
            assertEquals(androidx.work.ListenableWorker.Result.success(),worker().doWork())
            assertEquals("Acknowledged snapshots must not be sent again",32,calls)
            assertEquals("No foreground service may be requested",0,foregroundAttempts)
            WatcherAutomation.lock.lock()
            try {
                assertEquals("Duplicate work must not wait past its Android job budget",
                    androidx.work.ListenableWorker.Result.success(),kotlinx.coroutines.withTimeout(1000){worker().doWork()})
            }finally{WatcherAutomation.lock.unlock()}
        }finally{
            WatcherAutomation.configure(context,false)
            prefs.edit().putBoolean("enabled",oldEnabled).putString("completed_slot",oldCompleted).commit();WatcherAutomation.uiVisible=oldVisible
            catalogPrefs.edit().putString("watcher_active_groups",oldCatalog).commit()
            WatcherGroups.setActive(oldGroups)
            context.deleteDatabase("watcher-outbox-v1.db")
        }
    }
}
