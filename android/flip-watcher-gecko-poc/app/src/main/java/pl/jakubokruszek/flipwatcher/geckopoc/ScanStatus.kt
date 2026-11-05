package pl.jakubokruszek.flipwatcher.geckopoc

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.work.WorkInfo
import androidx.work.WorkManager
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeUnit

/** No post text, URLs, credentials or invented percentages. */
data class ScanState(
    val run:String="", val phase:String="IDLE", val started:Long=0, val changed:Long=0,
    val heartbeat:Long=0, val ended:Long=0, val lastSuccess:Long=0,
    val group:String="", val position:Int=0, val total:Int=0, val done:Int=0,
    val posts:Int=0, val photos:Int=0, val uploads:Int=0, val reason:String="",
    val checked:Long=0, val skipped:String="", val groupStarted:Long=0
) { val active get()=phase in setOf("PREPARING","UPLOADING","LOADING","READING","OCR","SAVING") }

object ScanStatusText {
    fun reason(code:String):String=when(code){
        "WAITING_FOR_BACKGROUND"->"Aplikacja jest otwarta. Przejdź na ekran główny telefonu, aby kontynuować skan w tle."
        "PAIRING_REQUIRED","WATCHER_PAIRING_REQUIRED","UPLOAD_HTTP_401","UPLOAD_HTTP_403"->"Połącz ponownie Watchera z Managerem."
        "LOGIN_REQUIRED"->"Facebook wymaga logowania. Otwórz sesję i zaloguj się ręcznie."
        "CHECKPOINT","CAPTCHA"->"Facebook wymaga ręcznego potwierdzenia lub CAPTCHA."
        "NETWORK_UNAVAILABLE","NETWORK_TIMEOUT"->"Nie udało się połączyć z siecią. Automat ponowi próbę."
        "PROFILE_LOAD_ERROR","PROFILE_NOT_READY","GROUP_LOAD_ERROR","GROUP_NOT_READY"->"Strona źródła nie załadowała się poprawnie."
        "SCAN_NO_CONSENT_OR_CONTEXT"->"Facebook nie potwierdził strony wybranej grupy (widoczności, logowania lub dostępu). To nie jest wynik odczytu postów."
        "WATCHER_SOURCES_INVALID","WATCHER_GROUPS_INVALID"->"Manager zwrócił nieprawidłową listę grup. Zapisane oferty i logowanie pozostają zachowane."
        "WATCHER_DEVICE_MISMATCH"->"Dane połączonego urządzenia nie zgadzają się z odpowiedzią Managera. Połącz ponownie Watchera."
        "NO_ACTIVE_GROUPS"->"Brak aktywnych grup. Zsynchronizuj grupy z Managerem."
        "ANDROID_FOREGROUND_START_DENIED"->"Android odmówił uruchomienia usługi w tle."
        "ANDROID_PERMISSION_DENIED"->"Android odmówił uprawnienia potrzebnego do pracy."
        "BATCH_CONTINUE"->"Osiągnięto limit czasu partii. Pozostałe grupy czekają na kolejną próbę."
        "SLOT_PARTIAL"->"Cykl został wykonany z brakami odczytu. Szczegóły są zachowane w diagnostyce; następny termin ponowi odczyt."
        "CAPTURE_PARTIAL"->"Cykl zakończony z brakami. Konkretne przyczyny i liczby dla źródeł są powyżej."
        "PAGE_HIDDEN","NO_POST_EVIDENCE","SCROLL_NOT_CONFIRMED","SALE_PHOTO_MISSING","CAPTURE_NOT_MEASURED"->"Odczyt źródła nie został potwierdzony ($code). Zaplanowano jedno ponowienie."
        "SLOT_COMPLETED"->"To okno zostało już wykonane. Automat czeka na następny termin."
        "WINDOW_NOT_DUE"->"Nowy termin skanu jeszcze nie nastąpił."
        "INTERRUPTED"->"Praca została przerwana. Zapisane wyniki i kolejka pozostają zachowane."
        "AUTOMATION_DISABLED"->"Automat jest wyłączony."
        "UPLOAD_RETRY"->"Wysyłka nie została potwierdzona; dane pozostają w kolejce."
        else->if(code.startsWith("UPLOAD_HTTP_"))"Manager odrzucił wysyłkę (${code.removePrefix("UPLOAD_HTTP_")}). Sprawdź połączenie i dziennik." else "Nie zakończono etapu ($code). Szczegóły są w dzienniku."
    }
    fun title(s:ScanState,enabled:Boolean,now:Long,running:Boolean?):String=when {
        !enabled->"Automat wyłączony"
        s.active&&now-s.heartbeat>90_000->if(running==true)"Zadanie uruchomione — brak świeżego potwierdzenia"else"Brak potwierdzenia dalszej pracy"
        s.phase=="QUEUED"->"Skan zlecony — oczekuje na uruchomienie"
        s.phase=="PREPARING"->"Przygotowanie skanu"
        s.phase=="UPLOADING"->"Wysyłanie zapisanych ofert"
        s.phase=="LOADING"->"Wczytywanie źródła"
        s.phase=="READING"->"Odczyt postów i zdjęć"
        s.phase=="OCR"->"Odczyt tekstu ze zdjęć ofert (OCR)"
        s.phase=="SAVING"->"Zapisywanie wyników"
        s.phase=="WAITING_UI"->"Skan wstrzymany — aplikacja jest otwarta"
        s.phase=="RETRY"->"Skan częściowy — oczekuje na ponowienie"
        s.phase=="DONE"->"Skan zakończony"
        s.phase=="UPLOAD_DONE"->"Wysyłka zakończona — oczekiwanie na skan"
        s.phase=="PARTIAL"->"Skan częściowy"
        s.phase=="ERROR"->"Skan zatrzymany"
        else->"Oczekiwanie na termin skanu"
    }
    fun time(at:Long,zone:ZoneId):String=if(at<=0)"brak" else Instant.ofEpochMilli(at).atZone(zone).format(DateTimeFormatter.ofPattern("dd.MM HH:mm:ss"))
    fun details(s:ScanState,enabled:Boolean,now:Long,next:Long,network:Boolean,notifications:Boolean,work:String,running:Boolean?,zone:ZoneId=ZoneId.systemDefault(),pendingWindow:Long=0):String=buildString {
        appendLine(title(s,enabled,now,running))
        if(s.total>0){appendLine("Źródła z zakończoną próbą: ${s.done}/${s.total}");if(s.group.isNotEmpty())appendLine("Źródło ${s.position}/${s.total}: ${s.group}")}
        if(s.groupStarted>0){
            val until=if(s.ended>0)s.ended else now
            val seconds=((until-s.groupStarted).coerceAtLeast(0)/1000)
            appendLine("Czas bieżącego źródła: ${seconds/60} min ${seconds%60} s"+(if(s.active)" • trwa" else " • próba zakończona"))
            appendLine("Budżety: wczytanie do 35 s, przewijanie do 45 s, OCR do 45 s. To limity, nie odliczanie do gwarantowanego końca.")
        }
        if(s.started>0){appendLine("Z tej próby: posty ${s.posts} • zdjęcia ${s.photos} • wysłane ${s.uploads}");appendLine("Start próby: ${time(s.started,zone)}")}
        if(s.changed>0)appendLine("Ostatnia zmiana etapu: ${time(s.changed,zone)}")
        if(s.active){
            appendLine("Potwierdzenie pracy: ${time(s.heartbeat,zone)}")
            if(now-s.heartbeat>90_000)appendLine("Proces nie potwierdza pracy. Android nie podał przyczyny; nie oznaczamy tej próby jako zakończonej.")
            else if(now-s.changed>60_000)appendLine("Etap trwa ponad minutę; aktualne potwierdzenie pracy nie oznacza znalezienia nowych postów.")
        }
        if(s.ended>0)appendLine("Koniec próby: ${time(s.ended,zone)}")
        appendLine("Ostatni cykl bez wykrytych braków odczytu: ${time(s.lastSuccess,zone)}")
        if(s.reason.isNotEmpty())appendLine("Powód: ${reason(s.reason)}")
        if(enabled){
            if(pendingWindow>0)appendLine("Bieżące okno: ${time(pendingWindow,zone)} — ukończenie nie zostało potwierdzone.")
            appendLine("Następne okno: ${time(next,zone)} (czas telefonu)")
            if(!network)appendLine("Start oczekuje na dostęp do internetu.")
            appendLine("Harmonogram Androida: $work")
            if(s.checked>0)appendLine("Ostatnia kontrola: ${time(s.checked,zone)}"+(if(s.skipped.isNotEmpty())" — ${reason(s.skipped)}" else ""))
            if(!notifications)appendLine("Powiadomienia o postępie są wyłączone w Androidzie.")
            append("Godzina jest planem. Android może opóźnić zadanie; po wymuszonym zatrzymaniu otwórz aplikację ponownie.")
        }
    }
}

object WatcherScanStatus {
    private val guard=Any()
    private const val PREFS="watcher-scan-status-v1"
    private const val CHANNEL="watcher-scan-progress-v1"
    private const val NOTICE=73573
    internal fun read(context:Context):ScanState=synchronized(guard){
        val j=runCatching{JSONObject(context.getSharedPreferences(PREFS,Context.MODE_PRIVATE).getString("state",null)?:"{}")} .getOrElse{JSONObject()}
        ScanState(j.optString("run"),j.optString("phase","IDLE"),j.optLong("started"),j.optLong("changed"),j.optLong("heartbeat"),j.optLong("ended"),j.optLong("lastSuccess"),j.optString("group"),j.optInt("position"),j.optInt("total"),j.optInt("done"),j.optInt("posts"),j.optInt("photos"),j.optInt("uploads"),j.optString("reason"),j.optLong("checked"),j.optString("skipped"),j.optLong("groupStarted"))
    }
    private fun change(context:Context,alert:Boolean=true,f:(ScanState)->ScanState):ScanState=synchronized(guard){
        val s=f(read(context));val j=JSONObject().put("run",s.run).put("phase",s.phase).put("started",s.started).put("changed",s.changed).put("heartbeat",s.heartbeat).put("ended",s.ended).put("lastSuccess",s.lastSuccess).put("group",s.group).put("position",s.position).put("total",s.total).put("done",s.done).put("posts",s.posts).put("photos",s.photos).put("uploads",s.uploads).put("reason",s.reason).put("checked",s.checked).put("skipped",s.skipped).put("groupStarted",s.groupStarted)
        check(context.getSharedPreferences(PREFS,Context.MODE_PRIVATE).edit().putString("state",j.toString()).commit())
        if(alert)notify(context,s)
        s
    }
    fun request(context:Context)=change(context){s->if(s.active&&System.currentTimeMillis()-s.heartbeat<90_000)s else ScanState(phase="QUEUED",changed=System.currentTimeMillis(),lastSuccess=s.lastSuccess,checked=s.checked,skipped=s.skipped)}
    fun begin(context:Context,id:String)=change(context){s->val now=System.currentTimeMillis();ScanState(run=id,phase="PREPARING",started=now,changed=now,heartbeat=now,lastSuccess=s.lastSuccess,checked=now)}
    fun update(context:Context,id:String,f:(ScanState)->ScanState)=change(context){s->if(s.run!=id||s.ended>0)s else f(s).copy(changed=System.currentTimeMillis(),heartbeat=System.currentTimeMillis())}
    fun beat(context:Context,id:String)=change(context,false){s->if(s.run==id&&s.active)s.copy(heartbeat=System.currentTimeMillis())else s}
    fun finish(context:Context,id:String,phase:String,reason:String="")=change(context){s->if(s.run!=id)s else {val now=System.currentTimeMillis();s.copy(phase=phase,reason=reason,ended=now,changed=now,heartbeat=now,lastSuccess=if(phase=="DONE")now else s.lastSuccess)}}
    fun checked(context:Context,reason:String)=change(context,false){it.copy(checked=System.currentTimeMillis(),skipped=reason)}
    fun quiet(context:Context){runCatching{context.getSystemService(NotificationManager::class.java).cancel(NOTICE)}}
    private fun notify(context:Context,s:ScanState){runCatching{
        val manager=context.getSystemService(NotificationManager::class.java)
        if(!WatcherAutomation.enabled(context)){manager.cancel(NOTICE);return}
        manager.createNotificationChannel(NotificationChannel(CHANNEL,"Postęp automatycznego skanu",NotificationManager.IMPORTANCE_LOW))
        if(!manager.areNotificationsEnabled())return
        val intent=PendingIntent.getActivity(context,NOTICE,Intent(context,ScanStatusActivity::class.java),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val title=ScanStatusText.title(s,true,System.currentTimeMillis(),true)
        val text=if(s.reason.isNotEmpty())ScanStatusText.reason(s.reason)else if(s.total>0)"Ukończone źródła ${s.done}/${s.total} • posty ${s.posts} • zdjęcia ${s.photos}"else "Otwórz aplikację, aby zobaczyć szczegóły."
        val notification=Notification.Builder(context,CHANNEL).setSmallIcon(android.R.drawable.ic_menu_search).setContentTitle(title).setContentText(text).setStyle(Notification.BigTextStyle().bigText(text)).setContentIntent(intent).setOnlyAlertOnce(true).setOngoing(s.active).setVisibility(Notification.VISIBILITY_PRIVATE).setWhen(s.started).setShowWhen(s.started>0)
        if(s.active)notification.setProgress(s.total,s.done,s.total==0)
        manager.notify(NOTICE,notification.build())
    }}
    /** IO only: constraints can prevent doWork from being entered at all. */
    fun report(context:Context):String {
        val now=System.currentTimeMillis();val enabled=WatcherAutomation.enabled(context)
        val network=runCatching{val c=context.getSystemService(ConnectivityManager::class.java);c.getNetworkCapabilities(c.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)==true}.getOrDefault(false)
        val notifications=runCatching{val n=context.getSystemService(NotificationManager::class.java);n.areNotificationsEnabled()&&n.getNotificationChannel(CHANNEL)?.importance!=NotificationManager.IMPORTANCE_NONE}.getOrDefault(false)
        val infos=runCatching{
            val m=WorkManager.getInstance(context)
            (listOf("watcher-calendar-v1","watcher-retry-v1","watcher-background-kick-v2").flatMap{m.getWorkInfosForUniqueWork(it).get(2,TimeUnit.SECONDS)}+m.getWorkInfosByTag("watcher-window-v2").get(2,TimeUnit.SECONDS)).distinctBy{it.id}.filter{!it.state.isFinished}
        }.getOrNull()
        val running=infos?.any{it.state==WorkInfo.State.RUNNING}
        val work=when {infos==null->"nie udało się odczytać stanu";running==true->"zadanie uruchomione";infos.any{it.state==WorkInfo.State.ENQUEUED}->"zadanie oczekuje; dokładny powód opóźnienia nie jest udostępniany";infos.any{it.state==WorkInfo.State.BLOCKED}->"zadanie zablokowane zależnością";else->"brak oczekującego zadania"}
        val next=AutomationPolicy.next(Instant.ofEpochMilli(now),ZoneId.systemDefault(),WatcherAutomation.schedule(context)).toEpochMilli()
        val window=AutomationPolicy.current(Instant.ofEpochMilli(now),ZoneId.systemDefault(),WatcherAutomation.schedule(context))
        val prefs=WatcherAutomation.preferences(context)
        val due=enabled&&window.at.toEpochMilli()>=prefs.getLong("schedule_since",0)&&prefs.getString("completed_slot",null)!=WatcherCaptureReport.cycle(window.key)
        val cycle=prefs.getString("capture_cycle",null)
        val evidence=if(cycle==null)"" else WatcherOutbox(context).use{WatcherCaptureReport.summary(it.cycleReports(cycle))}
        return (if(evidence.isEmpty())""else evidence+"\n\n")+ScanStatusText.details(read(context),enabled,now,next,network,notifications,work,running,pendingWindow=if(due)window.at.toEpochMilli()else 0)
    }
}
