@file:OptIn(ExperimentalMaterial3Api::class)

package pl.jakubokruszek.flipcollector.watcher.android

import android.app.TimePickerDialog
import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import pl.jakubokruszek.flipcollector.watcher.DeviceConditions
import pl.jakubokruszek.flipcollector.watcher.GroupSelection
import pl.jakubokruszek.flipcollector.watcher.ScanPreconditions
import pl.jakubokruszek.flipcollector.watcher.ScanRecord
import pl.jakubokruszek.flipcollector.watcher.ScanSchedule
import pl.jakubokruszek.flipcollector.watcher.ScanState
import pl.jakubokruszek.flipcollector.watcher.ScanTrigger
import pl.jakubokruszek.flipcollector.watcher.StartResult
import pl.jakubokruszek.flipcollector.watcher.WatchedGroup
import java.time.DayOfWeek
import java.time.Instant
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID

private val DAY_LABELS = listOf(
    DayOfWeek.MONDAY to "Pn", DayOfWeek.TUESDAY to "Wt", DayOfWeek.WEDNESDAY to "Śr", DayOfWeek.THURSDAY to "Cz",
    DayOfWeek.FRIDAY to "Pt", DayOfWeek.SATURDAY to "Sb", DayOfWeek.SUNDAY to "Nd",
)
private val TIME_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("dd.MM HH:mm")
private val FACEBOOK_SOURCE = Regex("^https://(www\\.|m\\.)?facebook\\.com/\\S+$", RegexOption.IGNORE_CASE)

/** Facebook Watcher → Ustawienia skanowania. */
@Composable
fun WatcherSettingsScreen(context: Context, onBack: () -> Unit) {
    val app = context.applicationContext
    val store = remember { WatcherRuntime.settings(app) }
    val coordinator = remember { WatcherRuntime.coordinator(app) }
    val gate = remember { WatcherRuntime.gate(app) }
    val scanState by coordinator.state.collectAsState()

    var schedule by remember { mutableStateOf(store.schedule()) }
    var groups by remember { mutableStateOf(store.groups()) }
    var selection by remember { mutableStateOf(store.selection()) }
    var history by remember { mutableStateOf(store.history()) }
    var conditions by remember { mutableStateOf(WatcherRuntime.conditions(app)) }
    var lastAutoCheck by remember { mutableStateOf(store.lastAutoCheck()) }
    var message by remember { mutableStateOf<String?>(null) }

    fun updateSchedule(next: ScanSchedule) {
        schedule = next
        store.saveSchedule(next)
        WatcherRuntime.applySchedule(app, next)
    }

    fun updateGroups(next: List<WatchedGroup>) {
        groups = next
        store.saveGroups(next)
        val current = selection
        if (current is GroupSelection.Single && next.none { it.id == current.groupId }) {
            selection = GroupSelection.AllActive
            store.saveSelection(GroupSelection.AllActive)
        }
    }

    // Wi-Fi and charging change while the screen is open.
    LaunchedEffect(Unit) {
        while (true) {
            conditions = WatcherRuntime.conditions(app)
            lastAutoCheck = store.lastAutoCheck()
            delay(5_000)
        }
    }
    // A finished scan lands in the history.
    LaunchedEffect(scanState) {
        if (scanState is ScanState.Idle) history = store.history()
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("← Wróć") }
            Spacer(Modifier.width(8.dp))
            Column {
                Text("Facebook Watcher", style = MaterialTheme.typography.labelLarge)
                Text("Ustawienia skanowania", style = MaterialTheme.typography.headlineSmall)
            }
        }

        if (!gate.open) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Tryb przygotowawczy", style = MaterialTheme.typography.titleMedium)
                    Text("Ta wersja nie otwiera Facebooka, nie pobiera zadań z Flip Managera i nie zapisuje sesji Facebooka. „Skanuj teraz” przechodzi przez wybrane grupy na próbę, żeby sprawdzić harmonogram, liczniki i historię.")
                }
            }
        }

        SectionTitle("Automat")
        LabeledSwitch("Włącz automatyczne skanowanie", schedule.enabled) { updateSchedule(schedule.copy(enabled = it)) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { pickTime(context, schedule.startMinutes) { updateSchedule(schedule.copy(startMinutes = it)) } }) {
                Text("Start ${ScanSchedule.format(schedule.startMinutes)}")
            }
            OutlinedButton(onClick = { pickTime(context, schedule.endMinutes) { updateSchedule(schedule.copy(endMinutes = it)) } }) {
                Text("Koniec ${ScanSchedule.format(schedule.endMinutes)}")
            }
        }
        if (schedule.crossesMidnight) Text("Okno przechodzi przez północ: liczy się dzień rozpoczęcia.", style = MaterialTheme.typography.bodySmall)
        Text("Dni tygodnia", style = MaterialTheme.typography.labelLarge)
        DAY_LABELS.chunked(4).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                row.forEach { (day, label) ->
                    FilterChip(
                        selected = day in schedule.days,
                        onClick = { updateSchedule(schedule.copy(days = if (day in schedule.days) schedule.days - day else schedule.days + day)) },
                        label = { Text(label) },
                    )
                }
            }
        }
        if (schedule.days.isEmpty()) Text("Nie wybrano żadnego dnia — automat nie ruszy.", color = MaterialTheme.colorScheme.error)
        LabeledSwitch("Tylko przez Wi-Fi", schedule.requireWifi) { updateSchedule(schedule.copy(requireWifi = it)) }
        LabeledSwitch("Tylko podczas ładowania", schedule.requireCharging) { updateSchedule(schedule.copy(requireCharging = it)) }
        Text(nextWindowText(schedule), style = MaterialTheme.typography.bodySmall)
        lastAutoCheck?.let { Text("Ostatnia kontrola automatu: $it", style = MaterialTheme.typography.bodySmall) }
        OutlinedButton(onClick = { updateSchedule(ScanSchedule.DEFAULT.copy(enabled = schedule.enabled)) }) { Text("Przywróć domyślne (codziennie 02:00–05:00)") }

        HorizontalDivider()
        SectionTitle("Grupy")
        GroupsEditor(groups, selection, onSelection = { selection = it; store.saveSelection(it) }, onGroups = ::updateGroups)

        HorizontalDivider()
        SectionTitle("Skan")
        ConditionsLine(conditions, schedule)
        val running = scanState as? ScanState.Running
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(enabled = running == null, onClick = {
                val blockers = ScanPreconditions.evaluate(ScanTrigger.MANUAL, schedule, conditions, groups, selection, insideWindow = true)
                message = if (blockers.isNotEmpty()) {
                    "Nie uruchomiono: ${blockers.joinToString(" ") { it.message }}"
                } else when (coordinator.start(ScanTrigger.MANUAL, selection.resolve(groups))) {
                    is StartResult.Started -> null
                    StartResult.AlreadyRunning -> "Skan już trwa."
                }
            }) { Text("Skanuj teraz") }
            OutlinedButton(enabled = running != null, onClick = { coordinator.stop() }) { Text("Zatrzymaj") }
        }
        running?.let { ProgressCard(it) }
        message?.let { Text(it, color = MaterialTheme.colorScheme.error) }

        HorizontalDivider()
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionTitle("Historia skanów")
            Spacer(Modifier.weight(1f))
            if (history.isNotEmpty()) TextButton(onClick = { store.clearHistory(); history = emptyList() }) { Text("Wyczyść") }
        }
        if (history.isEmpty()) Text("Brak skanów.", style = MaterialTheme.typography.bodySmall)
        history.forEach { HistoryRow(it) }
    }
}

@Composable
private fun SectionTitle(text: String) = Text(text, style = MaterialTheme.typography.titleMedium)

@Composable
private fun LabeledSwitch(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun GroupsEditor(
    groups: List<WatchedGroup>,
    selection: GroupSelection,
    onSelection: (GroupSelection) -> Unit,
    onGroups: (List<WatchedGroup>) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    val active = groups.filter { it.active }

    SelectionRow("Wszystkie aktywne (${active.size})", selection == GroupSelection.AllActive) { onSelection(GroupSelection.AllActive) }
    groups.forEach { group ->
        Column {
            SelectionRow(group.name, selection == GroupSelection.Single(group.id), enabled = group.active) { onSelection(GroupSelection.Single(group.id)) }
            Row(Modifier.padding(start = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(group.url, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                TextButton(onClick = { onGroups(groups.map { if (it.id == group.id) it.copy(active = !it.active) else it }) }) {
                    Text(if (group.active) "Wyłącz" else "Włącz")
                }
                TextButton(onClick = { onGroups(groups.filterNot { it.id == group.id }) }) { Text("Usuń") }
            }
        }
    }
    if (groups.isEmpty()) Text("Dodaj grupy obserwowane w Flip Managerze. Lista jest przechowywana tylko w telefonie.", style = MaterialTheme.typography.bodySmall)
    OutlinedTextField(name, { name = it }, label = { Text("Nazwa grupy") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
    OutlinedTextField(url, { url = it }, label = { Text("Link (https://www.facebook.com/groups/…)") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
    val normalizedUrl = url.trim().replace(Regex("^https://(m\\.)?facebook\\.com/", RegexOption.IGNORE_CASE), "https://www.facebook.com/")
    Button(
        enabled = name.isNotBlank() && FACEBOOK_SOURCE.matches(url.trim()) && groups.none { it.url.equals(normalizedUrl, ignoreCase = true) },
        onClick = {
            onGroups(groups + WatchedGroup(UUID.randomUUID().toString(), name.trim(), normalizedUrl))
            name = ""
            url = ""
        },
    ) { Text("Dodaj grupę") }
}

@Composable
private fun SelectionRow(label: String, selected: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().selectable(selected = selected, enabled = enabled, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onClick, enabled = enabled)
        Text(if (enabled) label else "$label (wyłączona)")
    }
}

@Composable
private fun ConditionsLine(conditions: DeviceConditions, schedule: ScanSchedule) {
    fun yesNo(value: Boolean) = if (value) "tak" else "nie"
    fun required(value: Boolean) = if (value) " (wymagane)" else ""
    val parts = listOf(
        "Wi-Fi: ${yesNo(conditions.onWifi)}${required(schedule.requireWifi)}",
        "Ładowanie: ${yesNo(conditions.charging)}${required(schedule.requireCharging)}",
        "Parowanie: ${yesNo(conditions.paired)}",
    )
    Text(parts.joinToString(" · "), style = MaterialTheme.typography.bodySmall)
}

@Composable
private fun ProgressCard(running: ScanState.Running) {
    val progress = running.progress
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(if (running.trigger == ScanTrigger.AUTOMATIC) "Skan automatyczny" else "Skan ręczny", style = MaterialTheme.typography.titleSmall)
            LinearProgressIndicator(
                progress = { if (progress.totalGroups == 0) 0f else progress.completedGroups.toFloat() / progress.totalGroups },
                modifier = Modifier.fillMaxWidth(),
            )
            Text("Grupy: ${progress.completedGroups}/${progress.totalGroups}")
            progress.currentGroup?.let { Text("Teraz: $it") }
            Text("Posty: ${progress.postsSeen} · wysłane: ${progress.postsSent} · błędy: ${progress.errors}")
        }
    }
}

@Composable
private fun HistoryRow(record: ScanRecord) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("${formatInstant(record.startedAt)} · ${if (record.trigger == ScanTrigger.AUTOMATIC) "automat" else "ręczny"} · ${record.outcome.label}", style = MaterialTheme.typography.titleSmall)
            Text("Grupy: ${record.groups} · posty: ${record.postsSeen} · wysłane: ${record.postsSent} · błędy: ${record.errors}", style = MaterialTheme.typography.bodySmall)
            record.message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

private fun nextWindowText(schedule: ScanSchedule): String {
    val window = schedule.nextWindow(ZonedDateTime.now(schedule.zone)) ?: return "Brak najbliższego okna."
    val prefix = if (schedule.enabled) "Najbliższe okno" else "Najbliższe okno (automat wyłączony)"
    return "$prefix: ${window.start.format(TIME_FORMAT)} – ${window.end.format(TIME_FORMAT)}"
}

private fun formatInstant(text: String): String = runCatching {
    Instant.parse(text).atZone(pl.jakubokruszek.flipcollector.watcher.WARSAW).format(TIME_FORMAT)
}.getOrDefault(text)

private fun pickTime(context: Context, minutes: Int, onPicked: (Int) -> Unit) {
    TimePickerDialog(context, { _, hour, minute -> onPicked(hour * 60 + minute) }, minutes / 60, minutes % 60, true).show()
}
