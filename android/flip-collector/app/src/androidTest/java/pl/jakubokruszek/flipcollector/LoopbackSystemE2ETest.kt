package pl.jakubokruszek.flipcollector

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.ListenableWorker
import androidx.work.testing.TestListenableWorkerBuilder
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.tls.HandshakeCertificates
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import pl.jakubokruszek.flipcollector.collector.*
import pl.jakubokruszek.flipcollector.integration.*
import pl.jakubokruszek.flipcollector.watcher.android.OfflineAutomationRuntime
import pl.jakubokruszek.flipcollector.watcher.android.AutoScanWorker
import pl.jakubokruszek.flipcollector.watcher.android.WatcherRuntime
import pl.jakubokruszek.flipcollector.watcher.ScanSchedule
import java.io.IOException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

/** Full 13-source engine, not a parallel happy-path client. Never a production origin. */
@RunWith(AndroidJUnit4::class)
class LoopbackSystemE2ETest {
    @Test fun androidToSignedApiPostgresAndReceiptCanBeRepeatedSafely() = runBlocking {
        val origin=InstrumentationRegistry.getArguments().getString("isolatedApiOrigin")
        assumeTrue("Isolated CI fixture not provisioned",origin!=null)
        require(origin=="https://10.0.2.2:55441")
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        val context=instrumentation.targetContext
        val pem=instrumentation.context.assets.open("isolated-test-cert.pem").bufferedReader().use { it.readText() }
        OfflineAutomationRuntime.configure(context,origin!!,pem)
        try {
        val signed=OfflineAutomationRuntime.client(context)
        assertFalse(BuildConfig.LIVE_COLLECTION_ENABLED)
        assertFalse(BuildConfig.ANDROID_BACKEND_INTEGRATION_ENABLED)
        assertTrue(signed.deviceStatus().getBoolean("paired"))
        val sources=signed.sources()
        assertEquals(13,sources.size);assertEquals(11,sources.count { it.sourceType=="GROUP" });assertEquals(2,sources.count { it.sourceType=="PROFILE" })
        assertEquals(1,sources.count { !it.enabled })
        var state=OfflineAutomationRuntime.state(context)
        val disabled=sources.single { it.name=="Offline source 1" }.remoteId
        state.groups(GroupSync.merge(emptyList(),sources) { it.remoteId }.first.map {
            if(it.remoteId==disabled) it.copy(group=it.group.copy(active=false)) else it
        })
        var loseResponse=true
        val flaky=object : AndroidQueueClient by signed {
            override fun sendCompletion(pending: PendingCompletion): JSONObject {
                val receipt=signed.sendCompletion(pending)
                if(loseResponse) { loseResponse=false;throw IOException("simulated response lost after commit") }
                return receipt
            }
        }
        val conditions=CycleConditions(false,true,true,90,false)
        suspend fun collect(job: ClaimedJob): JSONObject {
            assertNotNull(signed.renewLease(job))
            return OfflineFixtureDocument.batch(context,job)
        }
        assertEquals("RECONCILIATION_REQUIRED",OfflineAutomation(flaky,state).run("fixture-night",System.currentTimeMillis()+480_000,{conditions},::collect))
        val firstPending=requireNotNull(state.load())
        // Simulate a killed process: recreate the encrypted journal and engine.
        state=OfflineAutomationRuntime.state(context)
        assertEquals("WINDOW_COMPLETE",OfflineAutomation(signed,state).run("fixture-night",System.currentTimeMillis()+480_000,{conditions},::collect))
        assertNull(state.load());assertNull(state.activeJob())
        assertEquals(11,state.load("fixture-night","OFFLINE_TEST")!!.finished.size)
        assertFalse(state.groups().single { it.remoteId==disabled }.group.active)
        val report=state.diagnostics()
        val results=report.getJSONArray("results")
        assertEquals(11,results.length())
        assertEquals(1,(0 until results.length()).count { results.getJSONObject(it).getString("status")=="failed" })
        fun total(key: String): Int=(0 until results.length()).sumOf { i -> results.getJSONObject(i).let { if(it.isNull(key)) 0 else it.getInt(key) } }
        assertEquals(9,total("created"));assertEquals(0,total("updated"));assertEquals(0,total("duplicates"))
        val receipt=signed.sendCompletion(firstPending)
        assertEquals(firstPending.completionId,receipt.getString("completionId"))
        assertEquals(1,receipt.getJSONObject("result").getInt("listingsCreated"))
        assertEquals("WINDOW_COMPLETE",OfflineAutomation(signed,state).run("fixture-night",System.currentTimeMillis()+480_000,{conditions},::collect))
        assertEquals(11,state.diagnostics().getJSONArray("results").length())
        val cert=CertificateFactory.getInstance("X.509").generateCertificate(pem.byteInputStream()) as X509Certificate
        val tls=HandshakeCertificates.Builder().addTrustedCertificate(cert).build()
        val http=OkHttpClient.Builder().sslSocketFactory(tls.sslSocketFactory(),tls.trustManager).build()
        fun stats(): JSONObject = http.newCall(okhttp3.Request.Builder().url(origin+"/__test/stats").build()).execute().use {
            assertTrue(it.isSuccessful);JSONObject(it.body!!.string())
        }
        assertEquals(9,stats().getInt("listings"));assertEquals(10,stats().getInt("completedBatches"))
        // Repeat every eligible source in a NEW window: no new rows or inflated updates.
        http.newCall(okhttp3.Request.Builder().url(origin+"/__test/requeue").post("{}".toRequestBody()).build()).execute().use { assertTrue(it.isSuccessful) }
        fun shell(command: String) { instrumentation.uiAutomation.executeShellCommand(command).use { descriptor ->
            android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes() }
        } }
        shell("dumpsys battery set level 90");shell("dumpsys battery set ac 1");shell("dumpsys battery set status 2")
        shell("svc wifi enable")
        val now=java.time.ZonedDateTime.now(pl.jakubokruszek.flipcollector.watcher.WARSAW)
        val minute=now.hour*60+now.minute
        val schedule=ScanSchedule(enabled=true,startMinutes=(minute+1439)%1440,endMinutes=(minute+60)%1440)
        WatcherRuntime.settings(context).saveSchedule(schedule)
        val window=requireNotNull(schedule.windowContaining(now))
        var attempts=0
        while(attempts++<50 && !OfflineAutomationRuntime.conditions(context).let { it.wifi && it.charging && (it.batteryPercent ?: 0)>=20 }) kotlinx.coroutines.delay(200)
        assertTrue("Emulator requires Wi-Fi",OfflineAutomationRuntime.conditions(context).wifi)
        val worker=TestListenableWorkerBuilder<AutoScanWorker>(context).build()
        assertEquals(ListenableWorker.Result.success(),worker.doWork())
        assertEquals("WINDOW_COMPLETE",state.diagnostics().getString("queue"))
        val repeated=state.diagnostics().getJSONArray("results")
        val next=(0 until repeated.length()).map { repeated.getJSONObject(it) }.filter { it.getString("window")==window.key }
        assertEquals(11,next.size)
        assertEquals(0,next.sumOf { if(it.isNull("created")) 0 else it.getInt("created") })
        assertEquals(9,next.sumOf { if(it.isNull("duplicates")) 0 else it.getInt("duplicates") })
        assertEquals(0,next.sumOf { if(it.isNull("updated")) 0 else it.getInt("updated") })
        assertEquals(9,stats().getInt("listings"));assertEquals(20,stats().getInt("completedBatches"))
        assertFalse(report.toString().contains("isolated-ci-device-token"));assertFalse(report.toString().contains("leaseToken"))
        } finally {
            // A fixture-enabled test must not change following DEMO worker tests.
            OfflineAutomationRuntime.disable(context)
            instrumentation.uiAutomation.executeShellCommand("dumpsys battery reset").close()
        }
    }
}
