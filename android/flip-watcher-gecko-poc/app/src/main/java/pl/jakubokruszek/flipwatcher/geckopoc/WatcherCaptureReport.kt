package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import android.os.PowerManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Numeric reader evidence and exact IDs only. Business text/images never enter diagnostics. */
object WatcherCaptureReport {
    fun cycle(key:String)="capture-2/"+key
    fun issue(value:SavedResult):String {
        val s=value.captureStats
        if(s.isEmpty())return "CAPTURE_NOT_MEASURED"
        if(s["pageVisible"]!=1)return "PAGE_HIDDEN"
        if(value.rows.isEmpty())return "NO_POST_EVIDENCE"
        if((s["scrollMoves"]?:0)==0&&value.rows.size<50)return "SCROLL_NOT_CONFIRMED"
        if(value.rows.any{it.intent=="SELL_PROPERTY"&&value.photos.none{p->p.postId==it.postId}})return "SALE_PHOTO_MISSING"
        return ""
    }
    fun create(context:Context,cycle:String,run:String,group:WatcherGroup,value:SavedResult?,issue:String):JSONObject {
        val power=context.getSystemService(PowerManager::class.java)
        return JSONObject().put("version",1).put("batchId",UUID.randomUUID().toString()).put("scanId",run)
            .put("cycle",cycle).put("groupId",group.id).put("appVersion",BuildConfig.VERSION_NAME)
            .put("versionCode",BuildConfig.VERSION_CODE).put("issue",issue)
            .put("interactive",power.isInteractive).put("idle",power.isDeviceIdleMode)
            .put("batteryExempt",power.isIgnoringBatteryOptimizations(context.packageName))
            .put("stats",JSONObject(value?.captureStats?:emptyMap<String,Int>()))
            .put("posts",JSONArray(value?.rows?.map{r->JSONObject().put("postId",r.postId).put("intent",r.intent)
                .put("qualification",r.qualification).put("photos",value.photos.count{it.postId==r.postId})}?:emptyList<JSONObject>()))
    }
    fun summary(reports:List<JSONObject>):String=buildString {
        if(reports.isEmpty())return@buildString
        appendLine("Cały cykl tej wersji: sprawdzone grupy ${reports.size} • posty ${reports.sumOf{it.getJSONArray("posts").length()}} • zapisane zdjęcia ${reports.sumOf{r->val p=r.getJSONArray("posts");(0 until p.length()).sumOf{p.getJSONObject(it).getInt("photos")}}}")
        val gaps=reports.filter{it.optString("issue").isNotEmpty()}
        if(gaps.isNotEmpty())appendLine("Grupy z niepotwierdzonym odczytem: ${gaps.size}. Brak wyniku nie oznacza braku ofert.")
        append("Wersja: ${BuildConfig.VERSION_NAME}. Limit: 50 zachowanych postów na grupę, do 45 s przewijania; raport nie potwierdza odczytu całej historii Facebooka.")
    }
}
