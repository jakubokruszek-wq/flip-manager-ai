@file:OptIn(ExperimentalMaterial3Api::class)

package pl.jakubokruszek.flipcollector.watcher.android

import android.Manifest
import android.app.TimePickerDialog
import android.content.Context
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Place
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import pl.jakubokruszek.flipcollector.BuildConfig
import pl.jakubokruszek.flipcollector.integration.BackendIntegration
import pl.jakubokruszek.flipcollector.ui.DemoBanner
import pl.jakubokruszek.flipcollector.ui.FlipCard
import pl.jakubokruszek.flipcollector.ui.FlipColors
import pl.jakubokruszek.flipcollector.ui.InfoRow
import pl.jakubokruszek.flipcollector.ui.LabeledProgress
import pl.jakubokruszek.flipcollector.ui.MetricTile
import pl.jakubokruszek.flipcollector.ui.SectionLabel
import pl.jakubokruszek.flipcollector.ui.StatusPill
import pl.jakubokruszek.flipcollector.ui.Tone
import pl.jakubokruszek.flipcollector.watcher.DemoData
import pl.jakubokruszek.flipcollector.watcher.DeviceConditions
import pl.jakubokruszek.flipcollector.watcher.DiagnosticEvent
import pl.jakubokruszek.flipcollector.watcher.DiagnosticLevel
import pl.jakubokruszek.flipcollector.watcher.Diagnostics
import pl.jakubokruszek.flipcollector.watcher.GroupSelection
import pl.jakubokruszek.flipcollector.watcher.ScanLimits
import pl.jakubokruszek.flipcollector.watcher.ScanMode
import pl.jakubokruszek.flipcollector.watcher.ScanOutcome
import pl.jakubokruszek.flipcollector.watcher.ScanPreconditions
import pl.jakubokruszek.flipcollector.watcher.ScanRecord
import pl.jakubokruszek.flipcollector.watcher.ScanSchedule
import pl.jakubokruszek.flipcollector.watcher.ScanState
import pl.jakubokruszek.flipcollector.watcher.ScanSummary
import pl.jakubokruszek.flipcollector.watcher.ScanTrigger
import pl.jakubokruszek.flipcollector.watcher.StartResult
import pl.jakubokruszek.flipcollector.watcher.WARSAW
import pl.jakubokruszek.flipcollector.watcher.WatchedGroup
import java.time.DayOfWeek
import java.time.Instant
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID

private enum class WatcherTab(val label: String) { HOME("Pulpit"), SCHEDULE("Harmonogram"), GROUPS("Grupy"), HISTORY("Historia") }

private val DAY_LABELS = listOf(
    DayOfWeek.MONDAY to "Pn", DayOfWeek.TUESDAY to "Wt", DayOfWeek.WEDNESDAY to "Śr", DayOfWeek.THURSDAY to "Cz",
    DayOfWeek.FRIDAY to "Pt", DayOfWeek.SATURDAY to "Sb", DayOfWeek.SUNDAY to "Nd",
)
private val TIME_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("dd.MM HH:mm")
private val FACEBOOK_SOURCE = Regex("^https://(www\\.|m\\.)?facebook\\.com/\\S+$", RegexOption.IGNORE_CASE)

/** Facebook Watcher: Pulpit, Harmonogram, Grupy, Historia. */
@Composable
fun FacebookWatcherScreen(context: Context, onBack: () -> Unit) {
    val app = context.applicationContext
    val store = remember { WatcherRuntime.settings(app) }
    val coordinator = remember { WatcherRuntime.coordinator(app) }
    val mode = remember { WatcherRuntime.mode(app) }
    val scanState by coordinator.state.collectAsState()

    var tab by rememberSaveable { mutableStateOf(WatcherTab.HOME) }
    var schedule by remember { mutableStateOf(store.schedule()) }
    var groups by remember { mutableStateOf(store.groups()) }
    var selection by remember { mutableStateOf(store.selection()) }
    var history by remember { mutableStateOf(store.history()) }
    var diagnostics by remember { mutableStateOf(store.diagnostics()) }
    var conditions by remember { mutableStateOf(WatcherRuntime.conditions(app)) }
    var lastAutoCheck by remember { mutableStateOf(store.lastAutoCheck()) }
    var message by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        while (true) {
            conditions = WatcherRuntime.conditions(app)
            lastAutoCheck = store.lastAutoCheck()
            delay(5_000)
        }
    }
    LaunchedEffect(scanState) {
        if (scanState is ScanState.Idle) {
            history = store.history()
            diagnostics = store.diagnostics()
        }
    }

    fun updateSchedule(next: ScanSchedule) {
        schedule = next
        store.saveSchedule(next)
        WatcherRuntime.applySchedule(app, next)
        store.log(DiagnosticLevel.INFO, "SCHEDULE_SAVED", "automat=${next.enabled} ${ScanSchedule.format(next.startMinutes)}–${ScanSchedule.format(next.endMinutes)} dni=${next.days.size} wifi=${next.requireWifi} ładowanie=${next.requireCharging}")
    }

    fun startScan() {
        val blockers = ScanPreconditions.evaluate(ScanTrigger.MANUAL, schedule, conditions, groups, selection, insideWindow = true, mode = mode, liveAllowed = mode == ScanMode.LIVE)
        if (blockers.isNotEmpty()) {
            message = "Nie uruchomiono: ${blockers.joinToString(" ") { it.message }}"
            return
        }
        val targets = if (mode == ScanMode.DEMO) DemoData.groups else selection.resolve(groups)
        message = when (coordinator.start(ScanTrigger.MANUAL, targets, WatcherRuntime.executor(app), ScanLimits.MANUAL)) {
            is StartResult.Started -> { store.log(DiagnosticLevel.INFO, "MANUAL_SCAN_START", "$mode, grupy: ${targets.size}"); null }
            StartResult.AlreadyRunning -> "Skan już trwa."
        }
    }

    Scaffold(
        containerColor = FlipColors.Surface,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Facebook Watcher", fontWeight = FontWeight.SemiBold)
                        Text(tab.label, fontSize = 12.sp, color = FlipColors.MutedForeground)
                    }
                },
                navigationIcon = { TextButton(onClick = onBack) { Text("←", fontSize = 20.sp) } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = FlipColors.Surface, titleContentColor = FlipColors.Foreground),
            )
        },
        bottomBar = {
            NavigationBar(containerColor = FlipColors.SurfaceElevated) {
                WatcherTab.entries.forEach { item ->
                    NavigationBarItem(
                        selected = tab == item,
                        onClick = { tab = item },
                        icon = { Icon(item.icon(), contentDescription = null) },
                        label = { Text(item.label) },
                        colors = NavigationBarItemDefaults.colors(selectedIconColor = FlipColors.OnGold, indicatorColor = FlipColors.Gold, selectedTextColor = FlipColors.Gold),
                    )
                }
            }
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (mode == ScanMode.DEMO) DemoBanner("Dane testowe. Facebook nie jest otwierany, nic nie trafia do Flip Managera.")
            when (tab) {
                WatcherTab.HOME -> HomeTab(scanState, conditions, schedule, history, groups, selection, message, lastAutoCheck, ::startScan, onStop = { coordinator.stop() })
                WatcherTab.SCHEDULE -> ScheduleTab(context, store, schedule, lastAutoCheck, ::updateSchedule)
                WatcherTab.GROUPS -> GroupsTab(groups, selection, mode, onSelection = { selection = it; store.saveSelection(it) }, onGroups = { next ->
                    groups = next
                    store.saveGroups(next)
                    val current = selection
                    if (current is GroupSelection.Single && next.none { it.id == current.groupId }) {
                        selection = GroupSelection.AllActive
                        store.saveSelection(GroupSelection.AllActive)
                    }
                })
                WatcherTab.HISTORY -> HistoryTab(history, diagnostics, conditions, schedule, onClearHistory = { store.clearHistory(); history = emptyList() }, onClearDiagnostics = { store.clearDiagnostics(); diagnostics = emptyList() })
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

private fun WatcherTab.icon() = when (this) {
    WatcherTab.HOME -> Icons.Filled.Home
    WatcherTab.SCHEDULE -> Icons.Filled.DateRange
    WatcherTab.GROUPS -> Icons.Filled.Place
    WatcherTab.HISTORY -> Icons.Filled.Info
}

// ---------------------------------------------------------------- Pulpit

@Composable
private fun HomeTab(
    scanState: ScanState,
    conditions: DeviceConditions,
    schedule: ScanSchedule,
    history: List<ScanRecord>,
    groups: List<WatchedGroup>,
    selection: GroupSelection,
    message: String?,
    lastAutoCheck: String?,
    onScan: () -> Unit,
    onStop: () -> Unit,
) {
    val running = scanState as? ScanState.Running
    val summary = ScanSummary.from(history, Instant.now())

    DeviceStatusRow(conditions, schedule)

    FlipCard(highlighted = running != null) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                SectionLabel("Skan")
                Text(
                    when {
                        running == null -> "Gotowy"
                        running.trigger == ScanTrigger.AUTOMATIC -> "Skan automatyczny trwa"
                        else -> "Skan ręczny trwa"
                    },
                    fontSize = 20.sp, fontWeight = FontWeight.SemiBold,
                )
            }
            if (running != null) StatusPill(if (running.mode == ScanMode.DEMO) "DEMO" else "NA ŻYWO", Tone.GOLD)
        }
        if (running != null) {
            val p = running.progress
            LabeledProgress("Grupy", p.completedGroups, p.totalGroups)
            p.currentGroup?.let { group ->
                LabeledProgress("Posty w grupie: $group", p.currentGroupPosts, p.currentGroupTotal)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                MetricTile("${p.offersFound}", "oferty", Tone.GOLD)
                MetricTile("${p.postsSeen}", "posty")
                MetricTile("${p.errors}", "błędy", if (p.errors > 0) Tone.DANGER else Tone.NEUTRAL)
            }
        } else {
            Text(scanTargetText(groups, selection), fontSize = 13.sp, color = FlipColors.MutedForeground)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(
                onClick = onScan,
                enabled = running == null,
                modifier = Modifier.weight(1f).height(52.dp),
                colors = ButtonDefaults.buttonColors(containerColor = FlipColors.Gold, contentColor = FlipColors.OnGold),
            ) { Text("Skanuj teraz", fontWeight = FontWeight.SemiBold) }
            OutlinedButton(
                onClick = onStop,
                enabled = running != null,
                modifier = Modifier.weight(1f).height(52.dp),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = FlipColors.Danger),
            ) { Text("Zatrzymaj") }
        }
        message?.let { Text(it, color = FlipColors.Danger, fontSize = 13.sp) }
    }

    FlipCard {
        SectionLabel("Wyniki")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MetricTile("${summary.offersToday}", "oferty dziś", Tone.GOLD)
            MetricTile("${summary.scansToday}", "skany dziś")
        }
        val last = summary.lastSuccessful
        InfoRow("Ostatni udany skan", last?.let { "${formatInstant(it.finishedAt)} · ${modeLabel(it)} · ${it.offersFound} ofert" } ?: "brak")
        summary.lastError?.let { InfoRow("Ostatni błąd", it, FlipColors.Danger) }
    }

    FlipCard {
        SectionLabel("Harmonogram")
        InfoRow("Automat", if (schedule.enabled) "włączony" else "wyłączony", if (schedule.enabled) FlipColors.Success else FlipColors.MutedForeground)
        InfoRow("Okno", "${ScanSchedule.format(schedule.startMinutes)}–${ScanSchedule.format(schedule.endMinutes)} · ${daysText(schedule)}")
        InfoRow("Najbliższe okno", nextWindowText(schedule))
        lastAutoCheck?.let { InfoRow("Ostatnia kontrola", it) }
    }

    FlipCard {
        SectionLabel("Integracja z Flip Managerem")
        Text("Oczekuje na kontrakt backendu. Aplikacja nie wykonuje jeszcze tych połączeń:", fontSize = 13.sp, color = FlipColors.MutedForeground)
        BackendIntegration.items.forEach { item ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("• ${item.title}", fontSize = 13.sp, modifier = Modifier.weight(1f))
                StatusPill("oczekuje", Tone.WARNING)
            }
        }
    }
}

@Composable
private fun DeviceStatusRow(conditions: DeviceConditions, schedule: ScanSchedule) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            StatusPill(
                if (conditions.onWifi) "Wi-Fi · połączono" else "Wi-Fi · brak",
                when {
                    conditions.onWifi -> Tone.SUCCESS
                    schedule.requireWifi -> Tone.DANGER
                    else -> Tone.NEUTRAL
                },
            )
            val battery = conditions.batteryPercent?.let { " $it%" } ?: ""
            StatusPill(
                if (conditions.charging) "Ładowanie$battery" else "Bateria$battery",
                when {
                    conditions.charging -> Tone.SUCCESS
                    schedule.requireCharging -> Tone.WARNING
                    else -> Tone.NEUTRAL
                },
            )
        }
        StatusPill(if (conditions.paired) "Sparowano z Flip Managerem" else "Niesparowane", if (conditions.paired) Tone.SUCCESS else Tone.NEUTRAL)
    }
}

// ----------------------------------------------------------- Harmonogram

@Composable
private fun ScheduleTab(context: Context, store: WatcherSettingsStore, schedule: ScanSchedule, lastAutoCheck: String?, onChange: (ScanSchedule) -> Unit) {
    var simulateError by remember { mutableStateOf(store.demoSimulateError()) }
    var notify by remember { mutableStateOf(store.notifyAfterScan()) }
    var canNotify by remember { mutableStateOf(WatcherRuntime.canNotify(context)) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> canNotify = granted }

    FlipCard {
        SectionLabel("Automat")
        ToggleRow("Automatyczne skanowanie", "Sprawdzane co ok. 15 min, najwyżej jeden skan na okno.", schedule.enabled) { onChange(schedule.copy(enabled = it)) }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            TimeButton("Start", schedule.startMinutes, Modifier.weight(1f)) { pickTime(context, schedule.startMinutes) { onChange(schedule.copy(startMinutes = it)) } }
            TimeButton("Koniec", schedule.endMinutes, Modifier.weight(1f)) { pickTime(context, schedule.endMinutes) { onChange(schedule.copy(endMinutes = it)) } }
        }
        if (schedule.crossesMidnight) Text("Okno przechodzi przez północ — liczy się dzień rozpoczęcia.", fontSize = 12.sp, color = FlipColors.MutedForeground)
        Text("Dni tygodnia", fontSize = 13.sp, color = FlipColors.MutedForeground)
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.fillMaxWidth()) {
            DAY_LABELS.forEach { (day, label) ->
                FilterChip(
                    selected = day in schedule.days,
                    onClick = { onChange(schedule.copy(days = if (day in schedule.days) schedule.days - day else schedule.days + day)) },
                    label = { Text(label, fontSize = 12.sp) },
                    modifier = Modifier.weight(1f),
                    colors = FilterChipDefaults.filterChipColors(selectedContainerColor = FlipColors.Gold, selectedLabelColor = FlipColors.OnGold),
                )
            }
        }
        if (schedule.days.isEmpty()) Text("Nie wybrano żadnego dnia — automat nie ruszy.", color = FlipColors.Danger, fontSize = 12.sp)
        Text(nextWindowText(schedule), fontSize = 12.sp, color = FlipColors.MutedForeground)
    }

    FlipCard {
        SectionLabel("Oszczędzanie baterii")
        ToggleRow("Tylko przez Wi-Fi", "Android wybudzi zadanie dopiero przy sieci bez limitu.", schedule.requireWifi) { onChange(schedule.copy(requireWifi = it)) }
        ToggleRow("Tylko podczas ładowania", "Bez ładowarki automat czeka do następnej kontroli.", schedule.requireCharging) { onChange(schedule.copy(requireCharging = it)) }
        InfoRow("Limit skanu automatycznego", "${ScanLimits.AUTOMATIC.total.toMinutes()} min (grupa: ${ScanLimits.AUTOMATIC.perGroup.toMinutes()} min)")
        InfoRow("Limit skanu ręcznego", "${ScanLimits.MANUAL.total.toMinutes()} min (grupa: ${ScanLimits.MANUAL.perGroup.toMinutes()} min)")
        lastAutoCheck?.let { InfoRow("Ostatnia kontrola automatu", it) }
        OutlinedButton(onClick = { onChange(ScanSchedule.DEFAULT.copy(enabled = schedule.enabled)) }, modifier = Modifier.fillMaxWidth()) { Text("Przywróć domyślne: codziennie 02:00–05:00, Wi-Fi, ładowarka") }
    }

    FlipCard {
        SectionLabel("Powiadomienia")
        ToggleRow("Powiadomienie po skanie", "Krótkie podsumowanie: wynik, oferty, błędy.", notify) { notify = it; store.saveNotifyAfterScan(it) }
        if (notify && !canNotify && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            OutlinedButton(onClick = { permission.launch(Manifest.permission.POST_NOTIFICATIONS) }, modifier = Modifier.fillMaxWidth()) { Text("Zezwól na powiadomienia") }
        }
    }

    FlipCard {
        SectionLabel("Tryb demo")
        ToggleRow("Symuluj błąd w skanie demo", "Skan przerwie się po 7 postach, żeby sprawdzić obsługę błędów.", simulateError) { simulateError = it; store.saveDemoSimulateError(it) }
    }
}

@Composable
private fun ToggleRow(title: String, subtitle: String?, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().clickable { onChange(!checked) }, verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 15.sp)
            subtitle?.let { Text(it, fontSize = 12.sp, color = FlipColors.MutedForeground) }
        }
        Spacer(Modifier.width(12.dp))
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            colors = SwitchDefaults.colors(checkedThumbColor = FlipColors.OnGold, checkedTrackColor = FlipColors.Gold),
        )
    }
}

@Composable
private fun TimeButton(label: String, minutes: Int, modifier: Modifier, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, modifier = modifier.height(64.dp)) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(label, fontSize = 11.sp, color = FlipColors.MutedForeground)
            Text(ScanSchedule.format(minutes), fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = FlipColors.Foreground)
        }
    }
}

// ----------------------------------------------------------------- Grupy

@Composable
private fun GroupsTab(groups: List<WatchedGroup>, selection: GroupSelection, mode: ScanMode, onSelection: (GroupSelection) -> Unit, onGroups: (List<WatchedGroup>) -> Unit) {
    var name by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    val active = groups.filter { it.active }

    if (mode == ScanMode.DEMO) {
        FlipCard(highlighted = true) {
            SectionLabel("Skan demo")
            Text("W trybie demo skan obejmuje tylko grupę testową „${DemoData.group.name}”. Wybór poniżej zadziała po włączeniu skanowania na żywo.", fontSize = 13.sp, color = FlipColors.MutedForeground)
        }
    }

    FlipCard {
        SectionLabel("Zakres skanu")
        SelectionRow("Wszystkie aktywne", "${active.size} z ${groups.size}", selection == GroupSelection.AllActive) { onSelection(GroupSelection.AllActive) }
        if (groups.isNotEmpty()) HorizontalDivider(color = FlipColors.Border)
        groups.forEach { group ->
            Column {
                SelectionRow(group.name, group.url, selection == GroupSelection.Single(group.id), enabled = group.active) { onSelection(GroupSelection.Single(group.id)) }
                Row(Modifier.padding(start = 48.dp)) {
                    TextButton(onClick = { onGroups(groups.map { if (it.id == group.id) it.copy(active = !it.active) else it }) }) { Text(if (group.active) "Wyłącz" else "Włącz") }
                    TextButton(onClick = { onGroups(groups.filterNot { it.id == group.id }) }) { Text("Usuń", color = FlipColors.Danger) }
                }
            }
        }
        if (groups.isEmpty()) Text("Brak grup. Dodaj je poniżej — lista jest przechowywana tylko w telefonie.", fontSize = 13.sp, color = FlipColors.MutedForeground)
    }

    FlipCard {
        SectionLabel("Dodaj grupę")
        OutlinedTextField(name, { name = it }, label = { Text("Nazwa grupy") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(url, { url = it }, label = { Text("Link: https://www.facebook.com/groups/…") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        val normalizedUrl = url.trim().replace(Regex("^https://(m\\.)?facebook\\.com/", RegexOption.IGNORE_CASE), "https://www.facebook.com/")
        val duplicate = groups.any { it.url.equals(normalizedUrl, ignoreCase = true) }
        if (url.isNotBlank() && !FACEBOOK_SOURCE.matches(url.trim())) Text("Link musi zaczynać się od https://www.facebook.com/", fontSize = 12.sp, color = FlipColors.Danger)
        if (duplicate) Text("Ta grupa już jest na liście.", fontSize = 12.sp, color = FlipColors.Danger)
        Button(
            enabled = name.isNotBlank() && FACEBOOK_SOURCE.matches(url.trim()) && !duplicate,
            onClick = {
                onGroups(groups + WatchedGroup(UUID.randomUUID().toString(), name.trim(), normalizedUrl))
                name = ""
                url = ""
            },
            colors = ButtonDefaults.buttonColors(containerColor = FlipColors.Gold, contentColor = FlipColors.OnGold),
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Dodaj grupę") }
        Text("Pobieranie listy grup z Flip Managera: oczekuje na kontrakt backendu.", fontSize = 12.sp, color = FlipColors.Warning)
    }
}

@Composable
private fun SelectionRow(title: String, subtitle: String?, selected: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().selectable(selected = selected, enabled = enabled, onClick = onClick).padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onClick, enabled = enabled)
        Column(Modifier.weight(1f)) {
            Text(if (enabled) title else "$title (wyłączona)", fontSize = 15.sp, color = if (enabled) FlipColors.Foreground else FlipColors.MutedForeground)
            subtitle?.let { Text(it, fontSize = 12.sp, color = FlipColors.MutedForeground, maxLines = 1) }
        }
    }
}

// --------------------------------------------------------------- Historia

@Composable
private fun HistoryTab(
    history: List<ScanRecord>,
    diagnostics: List<DiagnosticEvent>,
    conditions: DeviceConditions,
    schedule: ScanSchedule,
    onClearHistory: () -> Unit,
    onClearDiagnostics: () -> Unit,
) {
    val clipboard = LocalClipboardManager.current
    var showDiagnostics by rememberSaveable { mutableStateOf(false) }

    Row(verticalAlignment = Alignment.CenterVertically) {
        SectionLabel("Skany (${history.size})", Modifier.weight(1f))
        if (history.isNotEmpty()) TextButton(onClick = onClearHistory) { Text("Wyczyść") }
    }
    if (history.isEmpty()) Text("Brak skanów. Uruchom „Skanuj teraz” na Pulpicie.", fontSize = 13.sp, color = FlipColors.MutedForeground)
    history.forEach { HistoryCard(it) }

    Spacer(Modifier.height(4.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
        SectionLabel("Diagnostyka (${diagnostics.size})", Modifier.weight(1f))
        TextButton(onClick = { showDiagnostics = !showDiagnostics }) { Text(if (showDiagnostics) "Ukryj" else "Pokaż") }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = {
            val header = listOf(
                "Flip Collector ${BuildConfig.VERSION_NAME} (${BuildConfig.APPLICATION_ID})",
                "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}), ${Build.MANUFACTURER} ${Build.MODEL}",
                "Wi-Fi=${conditions.onWifi} ładowanie=${conditions.charging} bateria=${conditions.batteryPercent ?: "?"}%",
                "Harmonogram: automat=${schedule.enabled} ${ScanSchedule.format(schedule.startMinutes)}–${ScanSchedule.format(schedule.endMinutes)} wifi=${schedule.requireWifi} ładowanie=${schedule.requireCharging}",
            )
            clipboard.setText(AnnotatedString(Diagnostics.export(diagnostics, header)))
        }, modifier = Modifier.weight(1f)) { Text("Kopiuj diagnostykę") }
        OutlinedButton(onClick = onClearDiagnostics, modifier = Modifier.weight(1f)) { Text("Wyczyść") }
    }
    if (showDiagnostics) {
        FlipCard {
            if (diagnostics.isEmpty()) Text("Brak wpisów.", fontSize = 13.sp, color = FlipColors.MutedForeground)
            diagnostics.take(60).forEach { event ->
                Column {
                    Text("${formatInstant(event.at)} · ${event.code}", fontSize = 12.sp, color = when (event.level) {
                        DiagnosticLevel.ERROR -> FlipColors.Danger
                        DiagnosticLevel.WARN -> FlipColors.Warning
                        DiagnosticLevel.INFO -> FlipColors.MutedForeground
                    })
                    Text(event.message, fontSize = 13.sp)
                }
            }
        }
    }
}

@Composable
private fun HistoryCard(record: ScanRecord) {
    var expanded by remember { mutableStateOf(false) }
    FlipCard(Modifier.clickable { expanded = !expanded }) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(formatInstant(record.startedAt), fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                Text("${if (record.trigger == ScanTrigger.AUTOMATIC) "Automat" else "Ręczny"} · ${modeLabel(record)}", fontSize = 12.sp, color = FlipColors.MutedForeground)
            }
            StatusPill(record.outcome.label, outcomeTone(record.outcome))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MetricTile("${record.offersFound}", "oferty", Tone.GOLD)
            MetricTile("${record.postsSeen}", "posty")
            MetricTile("${record.errors}", "błędy", if (record.errors > 0) Tone.DANGER else Tone.NEUTRAL)
        }
        record.message?.let { Text(it, fontSize = 13.sp, color = if (record.errors > 0 || !record.outcome.successful) FlipColors.Danger else FlipColors.MutedForeground) }
        record.stopReason?.let { InfoRow("Powód zatrzymania", it, FlipColors.Warning) }
        if (expanded) {
            HorizontalDivider(color = FlipColors.Border)
            InfoRow("Koniec", formatInstant(record.finishedAt))
            InfoRow("Wysłane do Flip Managera", "${record.postsSent}")
            record.groupReports.forEach { report ->
                InfoRow(report.groupName, report.error ?: "${report.postsSeen} postów · ${report.offersFound} ofert", if (report.error != null) FlipColors.Danger else FlipColors.Foreground)
            }
        } else if (record.groupReports.isNotEmpty()) {
            Text("Dotknij, aby zobaczyć szczegóły grup", fontSize = 12.sp, color = FlipColors.MutedForeground)
        }
    }
}

// ---------------------------------------------------------------- helpers

private fun outcomeTone(outcome: ScanOutcome) = when (outcome) {
    ScanOutcome.COMPLETED, ScanOutcome.DRY_RUN -> Tone.SUCCESS
    ScanOutcome.PARTIAL, ScanOutcome.STOPPED, ScanOutcome.TIMED_OUT -> Tone.WARNING
    ScanOutcome.FAILED -> Tone.DANGER
    ScanOutcome.BLOCKED -> Tone.NEUTRAL
}

private fun modeLabel(record: ScanRecord) = if (record.mode == ScanMode.DEMO) "DEMO" else "na żywo"

private fun scanTargetText(groups: List<WatchedGroup>, selection: GroupSelection): String = when (selection) {
    GroupSelection.AllActive -> "Zakres: wszystkie aktywne grupy (${groups.count { it.active }})"
    is GroupSelection.Single -> "Zakres: ${groups.firstOrNull { it.id == selection.groupId }?.name ?: "wybrana grupa"}"
}

private fun daysText(schedule: ScanSchedule): String = when (schedule.days.size) {
    7 -> "codziennie"
    0 -> "brak dni"
    else -> DAY_LABELS.filter { it.first in schedule.days }.joinToString(" ") { it.second }
}

private fun nextWindowText(schedule: ScanSchedule): String {
    val window = schedule.nextWindow(ZonedDateTime.now(schedule.zone)) ?: return "brak"
    return "${window.start.format(TIME_FORMAT)} – ${window.end.format(TIME_FORMAT)}"
}

private fun formatInstant(text: String): String = runCatching { Instant.parse(text).atZone(WARSAW).format(TIME_FORMAT) }.getOrDefault(text)

private fun pickTime(context: Context, minutes: Int, onPicked: (Int) -> Unit) {
    TimePickerDialog(context, { _, hour, minute -> onPicked(hour * 60 + minute) }, minutes / 60, minutes % 60, true).show()
}
