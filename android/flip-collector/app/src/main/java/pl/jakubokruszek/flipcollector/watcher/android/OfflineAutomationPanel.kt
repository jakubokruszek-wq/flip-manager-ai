package pl.jakubokruszek.flipcollector.watcher.android

import android.content.Context
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.*
import java.time.Instant

/** Explicit fixture controls; never uses production credentials or FB sessions. */
@Composable
fun OfflineAutomationPanel(context: Context) {
    val scope=rememberCoroutineScope()
    var origin by remember { mutableStateOf("https://localhost:55441") }
    var certificate by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("") }
    var snapshot by remember { mutableStateOf(OfflineAutomationRuntime.state(context).diagnostics()) }
    var task by remember { mutableStateOf<Job?>(null) }
    LaunchedEffect(Unit) {
        while(isActive) { snapshot=OfflineAutomationRuntime.state(context).diagnostics(); delay(2_000) }
    }
    Card {
        Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
            Text("OFFLINE TEST · Watcher 0.6",style=MaterialTheme.typography.titleMedium)
            Text("Tylko lokalne HTML i testowe API HTTPS. DEMO i produkcja mają oddzielne dane. LIVE jest wyłączony.")
            Text("Urządzenie: "+(if(snapshot.optBoolean("paired")) "sparowane z fixture" else "brak potwierdzenia"))
            Text("Synchronizacja: "+snapshot.optLong("lastSync").takeIf { it>0 }?.let { Instant.ofEpochMilli(it).toString() }.orEmpty())
            Text("Kolejka: "+snapshot.optString("queue")+" · outbox: "+(if(snapshot.optBoolean("pending")) "oczekuje" else "pusty"))
            Text("Błąd: "+snapshot.optString("error").ifBlank { "brak" })
            if(!OfflineAutomationRuntime.enabled(context)) {
                OutlinedTextField(origin,{origin=it},label={Text("Lokalny origin HTTPS")},singleLine=true)
                OutlinedTextField(certificate,{certificate=it},label={Text("Publiczny certyfikat PEM fixture")},maxLines=4)
                Button(onClick={
                    message=runCatching { OfflineAutomationRuntime.configure(context,origin,certificate); "Fixture skonfigurowane" }.getOrElse { "Niepoprawny origin lub certyfikat" }
                }) { Text("Połącz z lokalnym fixture") }
            }
            Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                Button(enabled=task?.isActive!=true && OfflineAutomationRuntime.enabled(context),onClick={
                    task=scope.launch {
                        try {
                            val schedule=WatcherRuntime.settings(context).schedule()
                            val window=schedule.windowContaining(java.time.ZonedDateTime.now(schedule.zone))
                            message=if(window==null) "Poza dozwolonym oknem" else OfflineAutomationRuntime.run(context,window.key,window.end.toInstant().toEpochMilli())
                        } catch(cancelled: CancellationException) { message="Przerwano; outbox zachowany"; throw cancelled }
                        catch(_: Exception) { message="OFFLINE_CYCLE_FAILED" }
                    }
                }) { Text("Cykl offline") }
                OutlinedButton(enabled=task?.isActive==true,onClick={task?.cancel()}) { Text("Zatrzymaj") }
            }
            OutlinedButton(onClick={task?.cancel(); OfflineAutomationRuntime.disable(context); message="Fixture wyłączone; stan zachowany"}) { Text("Odłącz fixture") }
            Text(message)
            val state=OfflineAutomationRuntime.state(context)
            state.groups().forEach { item ->
                Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) {
                    Text(item.group.name+" · "+item.sourceType+" · "+item.accessStatus,Modifier.weight(1f))
                    Switch(checked=item.group.active,onCheckedChange={ enabled ->
                        state.groups(state.groups().map { if(it.remoteId==item.remoteId) it.copy(group=it.group.copy(active=enabled)) else it })
                        snapshot=state.diagnostics()
                    })
                }
            }
            val rows=snapshot.getJSONArray("results")
            for(index in 0 until rows.length()) {
                val row=rows.getJSONObject(index)
                fun count(key: String)=if(row.isNull(key)) "?" else row.getInt(key).toString()
                Text(row.getString("name")+" · "+row.getString("status")+" · dodano "+count("created")+
                    " · zmieniono "+count("updated")+" · duplikaty "+count("duplicates")+" · pominięto "+count("skipped")+" · "+row.optString("error"))
            }
        }
    }
}
