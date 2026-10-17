package pl.jakubokruszek.flipcollector

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.tls.HandshakeCertificates
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import pl.jakubokruszek.flipcollector.collector.*
import pl.jakubokruszek.flipcollector.integration.EncryptedAutomationStorage
import pl.jakubokruszek.flipcollector.watcher.android.*
import java.io.IOException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

/** Two instrument invocations with an actual am force-stop between them. Local fixtures only. */
@RunWith(AndroidJUnit4::class)
class LivePilotProcessRecoveryTest {
    private class ResponseLost : IOException("fixture response lost")
    @Test fun outboxSurvivesActualApplicationProcessRestart() = runBlocking {
        val args=InstrumentationRegistry.getArguments()
        val phase=args.getString("pilotCrashPhase")
        assumeTrue("Two-phase process proof only",phase in setOf("seed","recover"))
        val origin=requireNotNull(args.getString("isolatedApiOrigin"))
        require(origin=="https://10.0.2.2:55441")
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        val context=instrumentation.targetContext
        val pem=instrumentation.context.assets.open("isolated-test-cert.pem").bufferedReader().use { it.readText() }
        OfflineAutomationRuntime.configure(context,origin,pem)
        try {
            val signed=OfflineAutomationRuntime.client(context)
            val cert=CertificateFactory.getInstance("X.509").generateCertificate(pem.byteInputStream()) as X509Certificate
            val tls=HandshakeCertificates.Builder().addTrustedCertificate(cert).build()
            val http=OkHttpClient.Builder().sslSocketFactory(tls.sslSocketFactory(),tls.trustManager).build()
            fun stats()=http.newCall(Request.Builder().url(origin+"/__test/stats").build()).execute().use {
                assertTrue(it.isSuccessful);JSONObject(requireNotNull(it.body).string())
            }
            val disk=EncryptedAutomationStorage(context,CollectorSigner.sha256Hex("PILOT_ACTUAL_PROCESS_RESTART_FIXTURE".toByteArray()))
            val state=LivePilotJournal(disk)
            val proof=context.getSharedPreferences("pilot_process_fixture_proof",0)
            if(phase=="seed") {
                assertNull(state.load())
                http.newCall(Request.Builder().url(origin+"/__test/requeue").post("{}".toRequestBody()).build()).execute().use { assertTrue(it.isSuccessful) }
                val source=signed.sources().single { it.name=="Offline source 0" }
                val before=stats()
                val flaky=object : AndroidQueueClient by signed {
                    override fun sendCompletion(pending:PendingCompletion):JSONObject {
                        assertNotNull(state.load())
                        signed.sendCompletion(pending)
                        throw ResponseLost()
                    }
                }
                try {
                    AndroidQueueSession(flaky,CompletionOutbox(state),enabled=true).runOne(listOf(source.remoteId),
                        onClaim=state::claimed,onReceipt=state::acknowledge) { job ->
                        val group=requireNotNull(job.group)
                        val bound=LivePilotSource(group.getString("id"),group.getString("sourceId"),group.getString("url"))
                        bound.checkJob(job)
                        val prefix=(100000+Math.floorMod(bound.sourceId.hashCode(),900000)).toString()
                        val html=context.assets.open("offline-source-template.html").bufferedReader().use { it.readText() }
                            .replace("https://www.facebook.com/groups/offline-lodz/posts/",bound.url+"posts/").replace("10000000000",prefix+"00000")
                        withContext(Dispatchers.Main) {
                            val browser=WebViewCollectorBrowser(context,LiveCollectionGate(true,true),pilotSource=bound)
                            browser.useLocalFixture(html)
                            try { browser.prepare(bound.url);LivePilotChannel(context,browser).collect(bound) }
                            finally { browser.close() }
                        }
                    }
                    fail("Expected dropped committed response")
                } catch (_:ResponseLost) { /* pending bytes must remain on disk */ }
                assertNotNull(LivePilotJournal(disk).load())
                assertTrue(proof.edit().putInt("pid",android.os.Process.myPid()).putInt("listings",before.getInt("listings"))
                    .putInt("batches",before.getInt("completedBatches")).commit())
            } else {
                assertTrue(proof.contains("pid"))
                assertNotEquals(proof.getInt("pid",-1),android.os.Process.myPid())
                val pending=requireNotNull(state.load())
                val receipt=CompletionOutbox(state).flush(signed,state::acknowledge)
                assertNotNull(receipt)
                assertNull(LivePilotJournal(disk).load())
                assertEquals(1,state.diagnostics().getInt("receipts"))
                signed.sendCompletion(pending) // fresh HMAC nonce, identical persisted body
                val after=stats()
                assertEquals(proof.getInt("listings",-1),after.getInt("listings"))
                assertEquals(proof.getInt("batches",-1)+1,after.getInt("completedBatches"))
            }
        } finally { OfflineAutomationRuntime.disable(context) }
    }
}
