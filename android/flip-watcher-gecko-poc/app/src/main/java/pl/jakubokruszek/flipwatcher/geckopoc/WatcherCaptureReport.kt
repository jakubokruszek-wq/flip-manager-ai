package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import android.os.PowerManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Numeric reader evidence and exact IDs only. Business text/images never enter diagnostics. */
object WatcherCaptureReport {
    fun cycle(key:String)="capture-2/reader4/"+key
    fun issue(value:SavedResult):String {
        val s=value.captureStats
        if(s.isEmpty())return "CAPTURE_NOT_MEASURED"
        if(s["pageVisible"]!=1)return "PAGE_HIDDEN"
        if(value.rows.isEmpty())return "NO_POST_EVIDENCE"
        if((s["scrollMoves"]?:0)==0&&value.rows.size<50)return "SCROLL_NOT_CONFIRMED"
        if(value.rows.any{(DesktopSummary.eligible(it)||DesktopPresentation.reviewable(it))&&value.photos.none{p->p.postId==it.postId}})return "SALE_PHOTO_MISSING"
        return ""
    }
    fun create(context:Context,cycle:String,run:String,group:WatcherGroup,value:SavedResult?,issue:String,elapsedMs:Long=0,queueStats:Map<String,Int> = emptyMap()):JSONObject {
        val power=context.getSystemService(PowerManager::class.java)
        return JSONObject().put("version",if(group.type=="PROFILE")2 else 1).apply{if(group.type=="PROFILE"){put("sourceType","PROFILE");put("sourceId",group.id)}}.put("batchId",UUID.randomUUID().toString()).put("scanId",run)
            .put("cycle",cycle).put("groupId",group.key).put("appVersion",BuildConfig.VERSION_NAME)
            .put("versionCode",BuildConfig.VERSION_CODE).put("issue",issue)
            .put("interactive",power.isInteractive).put("idle",power.isDeviceIdleMode)
            .put("batteryExempt",power.isIgnoringBatteryOptimizations(context.packageName))
            .put("stats",JSONObject(value?.captureStats?:emptyMap<String,Int>()).apply{
                if(elapsedMs>0)put("groupElapsedMs",elapsedMs.coerceAtMost(100_000_000L))
                for((key,count)in queueStats)if(key in setOf("queuePending","queueBlocked","queueQualityHeld","queueSent")&&count in 0..100_000_000)put(key,count)
            })
            .put("posts",JSONArray(value?.rows?.map{r->JSONObject().put("postId",r.postId).put("intent",r.intent)
                .put("qualification",r.qualification).put("photos",value.photos.count{it.postId==r.postId})}?:emptyList<JSONObject>()))
    }
    fun summary(reports:List<JSONObject>):String=buildString {
        if(reports.isEmpty())return@buildString
        appendLine("Ostatni odczyt każdego źródła w cyklu: źródła ${reports.size} • posty ${reports.sumOf{it.getJSONArray("posts").length()}} • zapisane zdjęcia ${reports.sumOf{r->val p=r.getJSONArray("posts");(0 until p.length()).sumOf{p.getJSONObject(it).getInt("photos")}}}")
        val gaps=reports.filter{it.optString("issue").isNotEmpty()}
        if(gaps.isNotEmpty()){
            val names=mapOf("PAGE_HIDDEN" to "strona nie była widoczna", "NO_POST_EVIDENCE" to "brak potwierdzonych postów", "SCROLL_NOT_CONFIRMED" to "brak potwierdzenia przewijania", "SALE_PHOTO_MISSING" to "brak zdjęć części kandydatów ofert", "CAPTURE_NOT_MEASURED" to "brak pomiaru odczytu")
            for((reason,items)in gaps.groupBy{it.optString("issue")})appendLine("${names[reason]?:reason}: ${items.size} źródeł")
            val missing=gaps.filter{it.optString("issue")=="SALE_PHOTO_MISSING"}.sumOf{r->val p=r.getJSONArray("posts");(0 until p.length()).count{val post=p.getJSONObject(it);post.optInt("photos")==0&&post.optString("intent")=="SELL_PROPERTY"}}
            if(missing>0)appendLine("Posty oznaczone jako sprzedaż bez zdjęcia: $missing. Ten brak nie oznacza problemu z przewijaniem.")
        }
        for(r in reports){
            val source=r.optString("groupId");val name=WatcherSources.find(source)?.name?:source
            val ms=r.optJSONObject("stats")?.optLong("groupElapsedMs")?:0
            val elapsed=if(ms>0)"${ms/60000} min ${ms/1000%60} s"else"niezmierzony w tej próbie"
            appendLine("$name — czas: $elapsed")
        }
        append("Wersja: ${BuildConfig.VERSION_NAME}. Limit: 50 zachowanych postów na źródło, do 45 s przewijania; raport nie potwierdza odczytu całej historii Facebooka.")
    }
}
