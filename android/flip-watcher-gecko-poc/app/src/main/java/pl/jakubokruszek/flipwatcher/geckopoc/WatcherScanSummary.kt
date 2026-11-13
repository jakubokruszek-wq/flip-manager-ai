package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import org.json.JSONObject
import java.time.ZoneId

/** Local, durable source counts. No post bodies, images, tokens or new database schema. */
object WatcherScanSummary {
    private val guard=Any()
    private var countedAt=0L
    private var countsKey=""
    private var counts=emptyMap<String,Int>()
    private fun read(c:Context)=runCatching{JSONObject(c.getSharedPreferences("watcher-source-summary-v1",Context.MODE_PRIVATE).getString("current",null)?:"{}")} .getOrElse{JSONObject()}
    private fun save(c:Context,j:JSONObject){check(c.getSharedPreferences("watcher-source-summary-v1",Context.MODE_PRIVATE).edit().putString("current",j.toString()).commit())}
    fun start(c:Context,cycle:String,groups:List<WatcherGroup>)=synchronized(guard){
        val previous=read(c)
        if(previous.optString("cycle")==cycle)return@synchronized
        val sources=JSONObject()
        for(g in groups)sources.put(g.key,JSONObject().put("name",g.name).put("type",g.type).put("attempted",false).put("new",0))
        val next=JSONObject().put("cycle",cycle).put("started",System.currentTimeMillis()).put("ended",0).put("sources",sources)
        val last=if(previous.optLong("ended")>0)JSONObject().put("started",previous.optLong("started")).put("ended",previous.optLong("ended"))else previous.optJSONObject("previous")
        if(last!=null)next.put("previous",last)
        countedAt=0L;save(c,next)
    }
    fun source(c:Context,cycle:String,g:WatcherGroup,readCount:Int?,issue:String)=synchronized(guard){
        val j=read(c);if(j.optString("cycle")!=cycle)return@synchronized
        val sources=j.optJSONObject("sources")?:return@synchronized
        val s=sources.optJSONObject(g.key)?:return@synchronized
        s.put("attempted",true).put("confirmed",readCount!=null&&issue !in setOf("NO_POST_EVIDENCE","PAGE_HIDDEN","CAPTURE_NOT_MEASURED")).put("issue",issue)
        if(readCount!=null)s.put("read",readCount)
        countedAt=0L;save(c,j)
    }
    fun finish(c:Context)=synchronized(guard){val j=read(c);if(j.has("started")){j.put("ended",System.currentTimeMillis());countedAt=0L;save(c,j)}}
    internal fun sourceDetails(c:Context):String=synchronized(guard){
        val cycle=read(c).optString("cycle")
        val reports=if(cycle.isEmpty())emptyList()else WatcherOutbox(c).use{it.cycleReports(cycle)}
        val elapsed=reports.associate{it.optString("groupId") to (it.optJSONObject("stats")?.optLong("groupElapsedMs")?:0L)}
        val evidence=WatcherCaptureReport.summary(reports,includeSources=false)
        text(c,elapsed=elapsed)+(if(evidence.isEmpty())""else "\n\n"+evidence)
    }
    fun text(c:Context,includeSources:Boolean=true,elapsed:Map<String,Long> = emptyMap()):String=synchronized(guard){
        val j=read(c);val sources=j.optJSONObject("sources")
        if(sources!=null){
            val key=j.optString("cycle")+":"+j.optLong("started")
            val now=android.os.SystemClock.elapsedRealtime()
            if(countedAt==0L||countsKey!=key||now-countedAt>=10_000L){
                counts=WatcherOutbox(c).use{it.newSourceOfferCounts(j.optLong("started"))}
                countsKey=key;countedAt=now
            }
            for(source in sources.keys())sources.getJSONObject(source).put("new",counts[source]?:0)
        }
        format(j,includeSources=includeSources,elapsed=elapsed)
    }
    internal fun format(j:JSONObject,zone:ZoneId=ZoneId.systemDefault(),includeSources:Boolean=true,elapsed:Map<String,Long> = emptyMap()):String=buildString{
        if(!j.has("started")){append("Ostatni skan — brak nowego raportu w tej wersji.");return@buildString}
        appendLine("Ostatni skan — rozpoczęcie: ${ScanStatusText.time(j.optLong("started"),zone)}")
        appendLine("Zakończenie: ${if(j.optLong("ended")>0)ScanStatusText.time(j.optLong("ended"),zone)else "niepotwierdzone — cykl trwa lub oczekuje na wznowienie"}")
        j.optJSONObject("previous")?.let{appendLine("Poprzedni zakończony skan: ${ScanStatusText.time(it.optLong("started"),zone)} — ${ScanStatusText.time(it.optLong("ended"),zone)}")}
        val sources=j.optJSONObject("sources")?:JSONObject()
        val entries=sources.keys().asSequence().map{sources.getJSONObject(it)}.toList()
        if(!includeSources){
            appendLine("Nowe oferty sprzedaży (także tekstowe): ${entries.sumOf{it.optInt("new")}}")
            append("Źródła z brakami odczytu: ${entries.count{it.optBoolean("attempted")&&it.optString("issue").isNotEmpty()}}. Szczegóły pod przyciskiem „Pokaż grupy i profile”.")
            return@buildString
        }
        appendLine("Nowe oferty według źródła:")
        for(key in sources.keys()){
            val s=sources.getJSONObject(key)
            val prefix=if(s.optString("type")=="PROFILE")"Profil"else"Grupa"
            val count=when{!s.optBoolean("attempted")->"jeszcze nie odczytano";!s.optBoolean("confirmed")->"brak potwierdzonego odczytu (wcześniej nowe: ${s.optInt("new")})";else->"nowe: ${s.optInt("new")} • odczytane oferty: ${s.optInt("read")}"}
            val ms=elapsed[key]?:0
            val duration=if(ms>0)" • czas: ${ms/60000} min ${ms/1000%60} s"else""
            appendLine("$prefix: ${s.optString("name")} — $count"+(if(s.optString("issue").isNotEmpty())" • odczyt częściowy"else"")+duration)
        }
        append("Liczniki nowych ofert odświeżamy najwyżej co 10 sekund oraz po zakończeniu odczytu źródła. Nowe = potwierdzone oferty z treścią lub zdjęciem po raz pierwszy zapisane w kolejce tego źródła. Ponowienia nie zwiększają wyniku; to nie jest liczba różnych mieszkań ani potwierdzenie wysyłki do Managera.")
    }
}
