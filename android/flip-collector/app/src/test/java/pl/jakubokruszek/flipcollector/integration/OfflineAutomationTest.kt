package pl.jakubokruszek.flipcollector.integration

import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import pl.jakubokruszek.flipcollector.collector.*
import java.io.IOException
import java.util.UUID

class OfflineAutomationTest {
    private class Disk : AtomicAutomationStorage {
        var raw: String?=null
        var failAfterWrite=false
        override fun read()=raw
        override fun write(value: String) { raw=value; if(failAfterWrite) { failAfterWrite=false; throw IOException("simulated disk interruption") } }
    }
    private val conditions=CycleConditions(false,true,true,80,false)
    private val signer=SignedCollectorClient(CollectorCredentials("https://localhost:55441","fixture","fixture-only-token"),LiveCollectionGate(false,false),metadataEnabled=true,dataMode="OFFLINE_TEST")
    private fun id(n: Int)=UUID(0,n.toLong()+1).toString()
    private inner class Api : AndroidQueueClient by signer {
        var sources=(0..12).map { RemoteGroup(id(it),"Source "+it,"https://www.facebook.com/groups/source-"+it+"/",true,
            if(it>=11) "PROFILE" else "GROUP",if(it==0) "high" else "normal",if(it==12) "UNAVAILABLE" else "CONNECTED") }
        val receipts=mutableMapOf<String,JSONObject>()
        var claims=0; var writes=0; var renewals=0
        var responseLoss=false; var expired=false; var offline=false
        override fun sources()=sources
        override fun deviceStatus(): JSONObject { if(offline) throw IOException(); return JSONObject().put("paired",true).put("consumerType","ANDROID_WEBVIEW") }
        override fun claim(sourceIds: List<String>?): ClaimedJob? {
            claims++;val source=sources.first { it.remoteId in sourceIds.orEmpty() }
            return ClaimedJob(UUID.randomUUID().toString(),UUID.randomUUID().toString(),"run","SOURCE_SCAN",
                JSONObject().put("id",source.remoteId).put("name",source.name))
        }
        override fun renewLease(job: ClaimedJob): String {
            renewals++;if(expired) { expired=false; throw CollectorHttpException(409,"ANDROID_JOB_LEASE_LOST") };return "renewed"
        }
        override fun sendCompletion(pending: PendingCompletion): JSONObject {
            val receipt=receipts.getOrPut(pending.completionId) {
                val body=JSONObject(pending.rawBody);if(body.getString("status")=="completed") writes++
                JSONObject().put("ok",true).put("completionId",pending.completionId)
                    .put("status",if(body.getString("status")=="completed") "completed" else "failed")
                    .put("result",JSONObject().put("skipped",0).put("writeAccounting",JSONObject().put("version",1).put("basis","TRANSACTIONAL").put("created",1).put("updated",0).put("duplicates",0)))
            }
            if(responseLoss) { responseLoss=false; throw IOException("lost response") }
            return receipt
        }
    }
    @Test fun thirteenSourcesResumeAfterLostResponseRespectLocalDisableAndContinueAfterFailure()=runBlocking {
        val disk=Disk();var state=AutomationState(disk);val api=Api();var now=0L
        val synced=GroupSync.merge(emptyList(),api.sources) { it.remoteId }.first
        state.groups(synced.map { if(it.remoteId==id(1)) it.copy(group=it.group.copy(active=false)) else it })
        val seen=mutableListOf<String>()
        suspend fun collect(job: ClaimedJob): JSONObject {
            val source=job.group!!.getString("id");seen+=source;now+=60_000
            if(source==id(5)) throw IOException("source unavailable")
            return JSONObject()
        }
        api.responseLoss=true
        assertEquals("RECONCILIATION_REQUIRED",OfflineAutomation(api,state,{now}).run("window",2_000_000,{conditions},::collect))
        assertNotNull(state.load())
        state=AutomationState(disk) // New process, same encrypted record contract.
        repeat(3) { OfflineAutomation(api,state,{now}).run("window",2_000_000,{conditions},::collect) }
        assertEquals(11,seen.size);assertEquals(11,seen.distinct().size)
        assertFalse(id(1) in seen);assertFalse(id(12) in seen)
        assertEquals(10,api.writes);assertNull(state.load());assertNull(state.activeJob())
        assertEquals(11,state.load("window","OFFLINE_TEST")!!.finished.size)
        val before=api.claims
        assertEquals("WINDOW_COMPLETE",OfflineAutomation(api,state,{now}).run("window",2_000_000,{conditions},::collect))
        assertEquals(before,api.claims)
        assertFalse(state.groups().first { it.remoteId==id(1) }.group.active)
    }
    @Test fun atomicReceiptCheckpointSurvivesDeathBeforeOutboxClear()=runBlocking {
        val disk=Disk();val state=AutomationState(disk);val api=Api()
        val job=api.claim(listOf(id(0)))!!
        state.save(WindowCursor("night","OFFLINE_TEST",listOf(id(0))))
        state.claimed("night",id(0),job)
        val outbox=CompletionOutbox(state);outbox.enqueue(api.prepareCompletion(job,batch=JSONObject()))
        disk.failAfterWrite=true
        try { outbox.flush(api,state::acknowledge);fail("expected interruption") } catch(_: IOException) {}
        assertNotNull(state.load())
        val restarted=AutomationState(disk)
        CompletionOutbox(restarted).flush(api,restarted::acknowledge)
        assertEquals(1,api.writes);assertEquals(1,restarted.diagnostics().getJSONArray("results").length())
        assertEquals(setOf(id(0)),restarted.load("night","OFFLINE_TEST")!!.finished)
    }
    @Test fun expiredJournalCanBeReclaimedButPendingImportIsNeverDiscarded()=runBlocking {
        val state=AutomationState(Disk());val api=Api();api.sources=api.sources.take(1)
        val job=api.claim(listOf(id(0)))!!
        state.claimed("night",id(0),job);api.expired=true
        assertEquals("WINDOW_COMPLETE",OfflineAutomation(api,state).run("night",System.currentTimeMillis()+200_000,{conditions}) { JSONObject() })
        assertEquals(1,api.writes);assertNull(state.activeJob())
    }
    @Test fun heartbeatAndCancellationLeaveDurableReceiptAndNoNewClaim()=runBlocking {
        val state=AutomationState(Disk());val api=Api();api.sources=api.sources.take(1)
        val job=launch {
            OfflineAutomation(api,state,heartbeatMs=5).run("night",System.currentTimeMillis()+200_000,{conditions}) {
                delay(80);throw CancellationException("manual stop")
            }
        }
        job.join()
        assertTrue(api.renewals>0);assertEquals(1,api.receipts.size)
        assertEquals("failed",api.receipts.values.single().getString("status"));assertNull(state.load())
    }
    @Test fun missingWifiOrExpiredWindowMakesNoApiCalls()=runBlocking {
        val state=AutomationState(Disk());val api=Api()
        assertEquals("DEVICE_CONSTRAINT",OfflineAutomation(api,state,{100}).run("night",100,{conditions}) { error("must not collect") })
        assertEquals("DEVICE_CONSTRAINT",OfflineAutomation(api,state,{0}).run("night",200_000,{conditions.copy(wifi=false)}) { error("must not collect") })
        assertEquals(0,api.claims)
    }
}
