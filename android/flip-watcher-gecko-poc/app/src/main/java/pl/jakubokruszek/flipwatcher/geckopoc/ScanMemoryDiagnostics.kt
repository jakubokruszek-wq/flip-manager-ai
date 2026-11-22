package pl.jakubokruszek.flipwatcher.geckopoc

import android.app.ActivityManager
import android.content.Context
import android.os.Debug
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Bounded local observations between sources, never page data or child-process totals.
 * Called on IO. Diagnostic failure must not interrupt a scan or its cleanup. */
internal object ScanMemoryDiagnostics {
    private const val STORE="watcher-memory-observations-v1"
    private const val LIMIT=12
    internal data class Sample(val stamp:Long,val pssKb:Long,val heapKb:Long,val nativeKb:Long,val availableKb:Long,val low:Boolean)
    private fun read(context:Context):Sample {
        val system=ActivityManager.MemoryInfo()
        context.getSystemService(ActivityManager::class.java).getMemoryInfo(system)
        val runtime=Runtime.getRuntime()
        return Sample(System.currentTimeMillis(),Debug.getPss(),(runtime.totalMemory()-runtime.freeMemory())/1024,
            Debug.getNativeHeapAllocatedSize()/1024,system.availMem/1024,system.lowMemory)
    }
    @Synchronized fun record(context:Context,after:Boolean,sample:()->Sample={read(context)}) {
        runCatching {
            val value=sample()
            val prefs=context.getSharedPreferences(STORE,Context.MODE_PRIVATE)
            val previous=runCatching{JSONArray(prefs.getString("samples","[]"))}.getOrElse{JSONArray()}
            val next=JSONArray()
            for(i in maxOf(0,previous.length()-LIMIT+1) until previous.length())next.put(previous.getJSONObject(i))
            next.put(JSONObject().put("time",value.stamp).put("after",after).put("pss",value.pssKb.coerceAtLeast(0))
                .put("heap",value.heapKb.coerceAtLeast(0)).put("native",value.nativeKb.coerceAtLeast(0))
                .put("available",value.availableKb.coerceAtLeast(0)).put("low",value.low))
            check(prefs.edit().putString("samples",next.toString()).commit())
        }
    }
    @Synchronized fun text(context:Context):String = runCatching {
        val rows=JSONArray(context.getSharedPreferences(STORE,Context.MODE_PRIVATE).getString("samples","[]"))
        if(rows.length()==0)return@runCatching "Pomiary pamięci między źródłami: jeszcze brak."
        val clock=DateTimeFormatter.ofPattern("dd.MM HH:mm:ss").withZone(ZoneId.systemDefault())
        "Pamięć procesu głównego między źródłami (bez procesów pomocniczych Gecko):\n"+(0 until rows.length()).joinToString("\n"){i->
            val row=rows.getJSONObject(i)
            "${clock.format(Instant.ofEpochMilli(row.getLong("time")))} • ${if(row.getBoolean("after"))"po zakończeniu źródła" else "przed źródłem"}"+
                " • PSS ${row.getLong("pss")/1024} MiB • Java ${row.getLong("heap")/1024} MiB • natywna ${row.getLong("native")/1024} MiB"+
                " • wolna systemu ${row.getLong("available")/1024} MiB • mało pamięci: ${if(row.getBoolean("low"))"tak" else "nie"}"
        }
    }.getOrDefault("Pomiary pamięci: odczyt niedostępny.")
}
