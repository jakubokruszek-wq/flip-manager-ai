package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import android.content.Intent
import android.os.PowerManager
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class WatcherWakeInstrumentedTest {
    private val context:Context=ApplicationProvider.getApplicationContext()
    private fun shell(command:String):String=InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command).use{
        android.os.ParcelFileDescriptor.AutoCloseInputStream(it).use{input->input.readBytes().toString(Charsets.UTF_8)}
    }
    @Test fun actualExactAlarmStartsForegroundScanInDozeWithoutWakingDisplay()=runBlocking {
        val prefs=WatcherAutomation.preferences(context);val backup=prefs.all.toMap()
        val power=context.getSystemService(PowerManager::class.java)
        val exemptBefore=power.isIgnoringBatteryOptimizations(context.packageName)
        val visible=WatcherAutomation.uiVisible;val factory=WatcherWake.runFactory
        val oldSources=WatcherSources.active.toList();val oldGroups=WatcherGroups.active.toList()
        val catalog=context.getSharedPreferences("gecko_poc",Context.MODE_PRIVATE);val oldCatalog=catalog.getString("watcher_active_groups",null)
        val group=WatcherGroup(FIXTURE_GROUP_ID,"Alarm fixture")
        val path="/groups/$FIXTURE_GROUP_ID/"
        val server=LoopbackFixtureServer(pages=mapOf(path to "desktop-viewport")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
        val read=CompletableDeferred<SavedResult>()
        try {
            WatcherAutomation.configure(context,false)
            context.deleteDatabase("watcher-outbox-v1.db")
            prefs.edit().clear().putBoolean("enabled",false).putLong("schedule_since",0).commit()
            WatcherAutomation.uiVisible=false
            WatcherWake.runFactory={c->object:WatcherAutomationRun(c,UUID.randomUUID()){
                override fun credentials(context:Context)=WatcherLink.Credentials("12345678-1234-1234-1234-123456789012","unused-local-fixture")
                override fun groups(credentials:WatcherLink.Credentials)=listOf(group)
                override fun send(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item)="fixture-receipt"
                override fun sendReport(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item){}
                override suspend fun scan(group:WatcherGroup,progress:(String)->Unit):SavedResult {
                    try{
                        val value=BackgroundWatcherScan(c).runFixture("http://127.0.0.1:${server.port}$path"){WatcherAutomation.enabled(c)}
                        read.complete(value);return value
                    }catch(e:Throwable){
                        android.util.Log.e("GeckoPocTest","WAKE_READ_FAILURE",e)
                        read.completeExceptionally(e);throw e
                    }
                }
            }}
            shell("appops set ${context.packageName} SCHEDULE_EXACT_ALARM allow")
            shell("dumpsys deviceidle whitelist +${context.packageName}")
            withTimeout(5000){while(!WatcherWake.exact(context))delay(100)}
            delay(1000)
            // Use a real next calendar minute: background scheduleNext calls
            // must preserve this same alarm, rather than replacing a synthetic
            // now+15s calendar alarm with the next configured daily time.
            val expected=((System.currentTimeMillis()+15_000)/60_000+1)*60_000
            val local=java.time.Instant.ofEpochMilli(expected).atZone(java.time.ZoneId.systemDefault())
            val minute=local.hour*60+local.minute
            val times=AutomationPolicy.validate(listOf(minute,(minute+480)%1440,(minute+960)%1440))
            prefs.edit().putBoolean("enabled",true).putString("scan_minutes",AutomationPolicy.encode(times)).commit()
            assertEquals(expected,AutomationPolicy.next(java.time.Instant.now(),java.time.ZoneId.systemDefault(),times).toEpochMilli())
            assertTrue(WatcherWake.schedule(context,expected))
            WatcherAutomation.scheduleNext(context)
            assertEquals(expected,prefs.getLong("wake_alarm_at",0))
            shell("input keyevent KEYCODE_HOME");shell("input keyevent KEYCODE_SLEEP")
            shell("dumpsys battery unplug");shell("dumpsys deviceidle force-idle")
            assertFalse(power.isInteractive);assertTrue("Fixture must actually enter Doze",power.isDeviceIdleMode)
            val value=withTimeout(180_000){read.await()}
            withTimeout(120_000){while(WatcherAlarmService.running)delay(100)}
            assertTrue(value.rows.isNotEmpty());assertTrue("Actual background Gecko must retain bound pixels",value.photos.isNotEmpty())
            assertFalse(prefs.getBoolean("last_service_screen_on",true))
            assertTrue("Alarm should execute while device is still in Doze",prefs.getBoolean("last_service_idle",false))
            assertEquals("exact_alarm_service",prefs.getString("last_start_trigger",null))
            val received=prefs.getLong("last_alarm_received",0)
            assertTrue(received>=expected-1000);assertTrue("Exact fixture alarm must not wait for display wake",received-expected<30_000)
            val state=WatcherScanStatus.read(context)
            assertTrue(state.phase in setOf("DONE","PARTIAL"));assertEquals(1,state.done);assertEquals(0,state.retrying)
            WatcherOutbox(context).use{assertTrue(it.scanned(prefs.getString("capture_cycle","")!!,group.key))}
            assertFalse(power.isInteractive)
        }catch(e:Throwable){
            val keys=setOf("enabled","scan_minutes","schedule_since","wake_alarm_at","wake_retry_at","last_alarm_expected","last_alarm_received","last_service_started","last_service_screen_on","last_service_idle","last_start_trigger")
            android.util.Log.e("GeckoPocTest","WAKE_DIAGNOSTIC "+org.json.JSONObject(prefs.all.filterKeys{it in keys}).toString()+" status="+WatcherScanStatus.read(context).toString())
            android.util.Log.e("GeckoPocTest","WAKE_ALARMS "+shell("dumpsys alarm").lines().filter{it.contains(context.packageName)||it.contains("WatcherAlarm")}.take(30).joinToString(" | "))
            android.util.Log.e("GeckoPocTest","WAKE_REPORTS "+WatcherOutbox(context).use{it.cycleReports(prefs.getString("capture_cycle","")!!).map{r->r.optString("issue")}}.joinToString(","))
            throw e
        }finally{
            WatcherAutomation.configure(context,false);context.stopService(Intent(context,WatcherAlarmService::class.java))
            withTimeoutOrNull(5000){while(WatcherAlarmService.running)delay(100)}
            WatcherWake.runFactory=factory;WatcherAutomation.uiVisible=visible
            WatcherSources.setActive(oldSources);WatcherGroups.setActive(oldGroups);catalog.edit().putString("watcher_active_groups",oldCatalog).commit()
            shell("dumpsys deviceidle unforce");shell("dumpsys battery reset")
            shell("input keyevent KEYCODE_WAKEUP");shell("wm dismiss-keyguard")
            if(!exemptBefore)shell("dumpsys deviceidle whitelist -${context.packageName}")
            // Android kills the app when exact-alarm access is revoked. CI
            // restores this app-op AFTER instrumentation returns, outside this
            // process; revoking here races delivery of the final test result.
            val edit=prefs.edit().clear();for((k,v)in backup)when(v){is String->edit.putString(k,v);is Boolean->edit.putBoolean(k,v);is Long->edit.putLong(k,v);is Int->edit.putInt(k,v)};edit.commit()
            context.deleteDatabase("watcher-outbox-v1.db");server.close()
        }
    }
    @Test fun disabledAutomationDoesNotScheduleAnAlarm(){
        val prefs=WatcherAutomation.preferences(context);val was=WatcherAutomation.enabled(context)
        try{prefs.edit().putBoolean("enabled",false).commit();assertFalse(WatcherWake.schedule(context,System.currentTimeMillis()+60_000))}
        finally{prefs.edit().putBoolean("enabled",was).commit()}
    }
}
