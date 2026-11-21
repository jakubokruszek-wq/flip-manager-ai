package pl.jakubokruszek.flipwatcher.geckopoc

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.SystemClock
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Local Android exit codes only: no exception messages, traces or page data. */
internal object AppExitDiagnostics {
    private var cached=""
    private var readAt=Long.MIN_VALUE
    @Synchronized fun text(context:Context):String {
        if(Build.VERSION.SDK_INT<30)return "Historia zakończeń procesów: niedostępna w tej wersji Androida."
        val now=SystemClock.elapsedRealtime()
        if(readAt!=Long.MIN_VALUE&&now-readAt<30_000)return cached
        cached=runCatching {
            val manager=context.getSystemService(ActivityManager::class.java)
            val records=manager.getHistoricalProcessExitReasons(context.packageName,0,5)
            val clock=DateTimeFormatter.ofPattern("dd.MM HH:mm:ss").withZone(ZoneId.systemDefault())
            val main=context.applicationInfo.processName?:context.packageName
            if(records.isEmpty())"Historia zakończeń procesów: Android nie zwrócił wpisów."
            else "Ostatnie zakończenia procesów (Android):\n"+records.joinToString("\n"){entry->
                val role=if(entry.processName==main)"główny" else "pomocniczy"
                val reason=when(entry.reason){
                    3->"mało pamięci"
                    4->"awaria Java"
                    5->"awaria natywna"
                    6->"brak odpowiedzi (ANR)"
                    10->"zatrzymanie przez użytkownika"
                    12->"zależność procesu"
                    15->"zmiana stanu pakietu"
                    16->"aktualizacja aplikacji"
                    else->"kod ${entry.reason}"
                }
                "${clock.format(Instant.ofEpochMilli(entry.timestamp))} • $role • $reason • status ${entry.status}"
            }
        }.getOrElse{"Historia zakończeń procesów: odczyt niedostępny."}
        readAt=now
        return cached
    }
}
