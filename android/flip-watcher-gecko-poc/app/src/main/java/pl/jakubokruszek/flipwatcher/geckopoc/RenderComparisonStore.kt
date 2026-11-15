package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.UUID

/** Latest diagnostic only. No page text, image bytes, pairing secret or offer queue. */
internal object RenderComparisonStore {
    private const val PREFS="watcher-render-comparison-v1"
    private const val KEY="latest"
    private const val MAX_BYTES=65536
    private val statKey=Regex("[A-Za-z][A-Za-z0-9]{0,40}")
    private fun preferences(context:Context)=context.getSharedPreferences(PREFS,Context.MODE_PRIVATE)
    private fun read(context:Context):JSONObject {
        val raw=preferences(context).getString(KEY,null)?:return JSONObject()
        return if(raw.length>MAX_BYTES)JSONObject() else runCatching{JSONObject(raw)}.getOrDefault(JSONObject())
    }
    private fun validRun(run:String)=runCatching{UUID.fromString(run).toString()==run}.getOrDefault(false)
    internal fun update(context:Context,run:String,group:WatcherGroup,arm:Int,result:RenderComparisonResult,reportId:String,upload:Int){
        synchronized(this){
            val current=read(context)
            // A delayed background arm from an older run cannot replace the new visible comparison.
            if(current.optString("run").isNotEmpty()&&current.optString("run")!=run&&arm!=1)return
            val next=if(current.optString("run")==run)current else JSONObject().put("run",run).put("group",group.id).put("arms",JSONObject())
            if(next.optString("group")!=group.id)return
            val arms=next.optJSONObject("arms")?:JSONObject().also{next.put("arms",it)}
            val existing=arms.optJSONObject(arm.toString())
            if(upload!=0&&existing?.optString("reportId")!=reportId)return
            arms.put(arm.toString(),JSONObject().put("issue",result.issue).put("stats",JSONObject(result.stats))
                .put("reportId",reportId).put("upload",upload))
            val encoded=next.toString();check(encoded.length<=MAX_BYTES)
            check(preferences(context).edit().putString(KEY,encoded).commit())
        }
    }
    fun begin(context:Context,run:String,group:WatcherGroup){
        require(validRun(run)&&group.type=="GROUP")
        synchronized(this){check(preferences(context).edit().putString(KEY,JSONObject().put("run",run).put("group",group.id).put("name",group.name.take(200)).put("started",System.currentTimeMillis()).put("arms",JSONObject()).toString()).commit())}
    }
    suspend fun record(context:Context,run:String,group:WatcherGroup,arm:Int,result:RenderComparisonResult){
        require(validRun(run)&&group.type=="GROUP"&&arm in 1..6)
        val issue=result.issue.takeIf{it.matches(Regex("[A-Z0-9_]{0,60}"))}?:"COMPARE_PROTOCOL"
        val stats=result.stats.filter{(key,value)->statKey.matches(key)&&value in 0..100_000_000}.entries.take(158).associate{it.key to it.value}+
            mapOf("comparisonArm" to arm,"renderDiagEnabled" to 1)
        val clean=RenderComparisonResult(issue,stats)
        val report=WatcherCaptureReport.create(context,WatcherCaptureReport.cycle("render-comparison/$run/$arm"),run,group,null,issue,failureStats=stats)
        val reportId=report.getString("batchId")
        update(context,run,group,arm,clean,reportId,0)
        val upload=withContext(Dispatchers.IO){
            try {
                val credentials=WatcherLink.load(context)?:return@withContext 3
                // Item is a transport value only: this never opens or writes WatcherOutbox.
                WatcherUpload.report(credentials,WatcherOutbox.Item(reportId,report.toString(),0))
                1
            }catch(e:CancellationException){throw e}catch(_:Exception){2}
        }
        update(context,run,group,arm,clean,reportId,upload)
    }
    fun summary(context:Context):String {
        val latest=synchronized(this){read(context)}
        if(latest.optString("run").isEmpty())return "Brak zapisanego porównania obrazu."
        val group=latest.optString("group")
        return buildString {
            appendLine("Grupa: ${latest.optString("name").ifEmpty{WatcherSources.find(group)?.name?:group}}")
            appendLine("Rozpoczęcie: ${java.text.DateFormat.getDateTimeInstance().format(java.util.Date(latest.optLong("started")))}")
            val arms=latest.optJSONObject("arms")?:JSONObject()
            for(arm in 1..6){
                val label=when(arm){1->"Widoczne okno";2->"Odczyt bez widoku, aplikacja na ekranie";3->"Odczyt po przejściu aplikacji w tło";4->"Test w tle z kontrolą pauzy Gecko";5->"Test w tle z usługą pierwszego planu";else->"Usługa pierwszego planu i korekta pauzy Gecko"}
                val result=arms.optJSONObject(arm.toString())
                appendLine();appendLine("$arm. $label")
                if(result==null){appendLine("Jeszcze nie wykonano.");continue}
                appendLine("Wynik: ${result.optString("issue")}")
                val stats=result.optJSONObject("stats")?:JSONObject()
                appendLine("Potwierdzony dokument: ${if(stats.optInt("comparisonDocument")==1)"tak"else"nie"}")
                appendLine("Przechwycony obraz: ${if(stats.optInt("comparisonCapture")==1)"tak"else"nie"}")
                appendLine("Obraz zawiera różne piksele: ${if(stats.optInt("comparisonVaried")==1)"tak"else"nie"}")
                appendLine("Elementy postów na stronie: ${stats.optInt("comparisonArticles")}")
                if(arm!=1&&stats.has("groupAcquiredFrames"))appendLine("Klatki ImageReader: ${stats.optInt("groupAcquiredFrames")}")
                if(stats.optInt("comparisonForegroundRequested")==1)appendLine("Usługa pierwszego planu: początek ${stats.optInt("comparisonForegroundAtStart")}, koniec ${stats.optInt("comparisonForegroundAtEnd")}")
                if(stats.has("timingStarted")){
                    appendLine("Pomiar animacji i timera: ${if(stats.optInt("timingReply5")==1)"ukończony"else"niepełny"}")
                    appendLine("25 s — animacje: ${stats.optInt("timingRafCount5")}, timer: ${stats.optInt("timingTimerCount5")}, klatki: ${stats.optInt("timingFrames5")}")
                }
                appendLine(when(result.optInt("upload")){1->"Raport diagnostyczny wysłany.";2->"Raport zachowany lokalnie; wysyłka nie powiodła się.";3->"Raport zachowany lokalnie; brak parowania.";else->"Raport zachowany lokalnie; brak potwierdzenia wysyłki."})
            }
            append("To test obrazu strony, nie potwierdzenie odczytania ofert.")
        }
    }
}
