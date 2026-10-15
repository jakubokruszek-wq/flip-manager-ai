package pl.jakubokruszek.flipcollector.integration

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import pl.jakubokruszek.flipcollector.collector.ClaimedJob
import pl.jakubokruszek.flipcollector.collector.OfflineDocumentCollector

/** Bundled fixtures only; source metadata changes links, never navigates anywhere. */
object OfflineFixtureDocument {
    suspend fun batch(context: Context, job: ClaimedJob): JSONObject {
        val group=requireNotNull(job.group)
        val sourceId=group.getString("sourceId")
        if(sourceId == "offline-5") throw IllegalStateException("OFFLINE_FIXTURE_SOURCE_FAILURE")
        val source=JSONObject().put("sourceId",sourceId).put("sourceType",group.getString("type")).put("sourceUrl",group.getString("url"))
        val prefix=(100000+Math.floorMod(sourceId.hashCode(),900000)).toString()
        val links=if(group.getString("type") == "GROUP") group.getString("url")+"posts/" else "https://www.facebook.com/"+sourceId+"/posts/"
        var html=if(sourceId == "offline-3") "<html><body></body></html>" else context.assets.open("offline-source-template.html").bufferedReader().use { it.readText() }
        html=html.replace("https://www.facebook.com/groups/offline-lodz/posts/",links).replace("10000000000",prefix+"00000")
        val result=OfflineDocumentCollector(context).collect(html,source)
        val count=result.getJSONArray("posts").length()
        return result.put("collectedAt",java.time.Instant.now().toString()).put("health",JSONObject()
            .put("status","HEALTHY").put("visibleCardCount",count).put("capturedPostCount",count)
            .put("scrolls",0).put("durationMs",100).put("stopReason","NO_NEW_IDS").put("reasons",JSONArray()))
    }
}
