@file:OptIn(ExperimentalMaterial3Api::class)

package pl.jakubokruszek.flipcollector.watcher.android

import androidx.compose.ui.platform.LocalContext
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
import pl.jakubokruszek.flipcollector.integration.GroupFetchResult
import pl.jakubokruszek.flipcollector.integration.GroupOrigin
import pl.jakubokruszek.flipcollector.integration.GroupSync
import pl.jakubokruszek.flipcollector.integration.PendingContractGroupSource
import pl.jakubokruszek.flipcollector.integration.SyncedGroup
import pl.jakubokruszek.flipcollector.theme.ThemeMode
import pl.jakubokruszek.flipcollector.ui.ThemeController
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
import pl.jakubokruszek.flipcollector.watcher.WindowLedger
import pl.jakubokruszek.flipcollector.watcher.WindowStatus
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import java.time.DayOfWeek
import java.time.Instant
import java.time.OffsetDateTime
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
    var synced by remember { mutableStateOf(store.syncedGroups()) }
    val groups = synced.map { it.group.copy(active = it.scannable) }
    var selection by remember { mutableStateOf(store.selection()) }
    var liveHistory by remember { mutableStateOf(store.history(ScanMode.LIVE)) }
    var demoHistory by remember { mutableStateOf(store.history(ScanMode.DEMO)) }
    var diagnostics by remember { mutableStateOf(store.diagnostics()) }
    var conditions by remember { mutableStateOf(WatcherRuntime.conditions(app)) }
    var lastAutoCheck by remember { mutableStateOf(store.lastAutoCheck()) }
    var message by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        WatcherRuntime.recoverInterruptedScan(app)?.let { recovered ->
            message = "Poprzedni skan (${if (recovered.mode == ScanMode.DEMO) "demo" else "na żywo"}) został przerwany przez zamknięcie aplikacji — zapisano go w historii."
            liveHistory = store.history(ScanMode.LIVE)
            demoHistory = store.history(ScanMode.DEMO)
        }
        while (true) {
            conditions = WatcherRuntime.conditions(app)
            lastAutoCheck = store.lastAutoCheck()
            delay(5_000)
        }
    }
    LaunchedEffect(scanState) {
        if (scanState is ScanState.Idle) {
            liveHistory = store.history(ScanMode.LIVE)
            demoHistory = store.history(ScanMode.DEMO)
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
                        colors = NavigationBarItemDefaults.colors(selectedIconColor = FlipColors.OnGold, indicatorColor = FlipColors.Gold, selectedTextColor = FlipColors.GoldText, unselectedIconColor = FlipColors.MutedForeground, unselectedTextColor = FlipColors.MutedForeground),
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
            if (pl.jakubokruszek.flipcollector.BuildConfig.DEBUG && tab == WatcherTab.HOME) OfflineAutomationPanel(context)
            when (tab) {
                WatcherTab.HOME -> HomeTab(mode, scanState, conditions, schedule, liveHistory, demoHistory, groups, selection, message, lastAutoCheck, ::startScan, onStop = { coordinator.stop() })
                WatcherTab.SCHEDULE -> ScheduleTab(context, store, schedule, lastAutoCheck, ::updateSchedule)
                WatcherTab.GROUPS -> GroupsTab(synced, selection, mode, store.lastGroupSync(), onSelection = { selection = it; store.saveSelection(it) }, onSync = { text -> store.saveLastGroupSync(text); store.log(DiagnosticLevel.INFO, "GROUP_SYNC", text) }, onGroups = { next ->
                    synced = next
                    store.saveSyncedGroups(next)
                    val current = selection
                    if (current is GroupSelection.Single && next.none { it.group.id == current.groupId }) {
                        selection = GroupSelection.AllActive
                        store.saveSelection(GroupSelection.AllActive)
                    }
                })
                WatcherTab.HISTORY -> HistoryTab(context, store, liveHistory, demoHistory, diagnostics, conditions, schedule, onClearHistory = { m -> store.clearHistory(m); if (m == ScanMode.LIVE) liveHistory = emptyList() else demoHistory = emptyList() }, onClearDiagnostics = { store.clearDiagnostics(); diagnostics = emptyList() }, onRefreshDiagnostics = { diagnostics = store.diagnostics() })
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
    mode: ScanMode,
    scanState: ScanState,
    conditions: DeviceConditions,
    schedule: ScanSchedule,
    liveHistory: List<ScanRecord>,
    demoHistory: List<ScanRecord>,
    groups: List<WatchedGroup>,
    selection: GroupSelection,
    message: String?,
    lastAutoCheck: String?,
    onScan: () -> Unit,
    onStop: () -> Unit,
) {
    val running = scanState as? ScanState.Running
    val live = ScanSummary.from(liveHistory, Instant.now())
    val demo = ScanSummary.from(demoHistory, Instant.now())

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
        } else if (mode == ScanMode.DEMO) {
            Text("Skan demo działa lokalnie: bez parowania, Wi-Fi i ładowarki. Wymagania z harmonogramu dotyczą automatu i skanowania na żywo.", fontSize = 13.sp, color = FlipColors.MutedForeground)
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

    // Real results and demo tests are never added together.
    FlipCard {
        SectionLabel("Wyniki Facebook Watchera (na żywo)")
        if (liveHistory.isEmpty()) {
            Text("Brak — skanowanie prawdziwych grup jest wyłączone w tej wersji.", fontSize = 13.sp, color = FlipColors.MutedForeground)
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                MetricTile("${live.offersToday}", "oferty dziś", Tone.GOLD)
                MetricTile("${live.scansToday}", "skany dziś")
            }
            InfoRow("Ostatni udany skan", live.lastSuccessful?.let { "${formatInstant(it.finishedAt)} · ${it.offersFound} ofert" } ?: "brak")
            live.lastError?.let { InfoRow("Ostatni błąd", it, FlipColors.Danger) }
        }
    }

    FlipCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionLabel("Testy demo", Modifier.weight(1f))
            StatusPill("dane testowe", Tone.NEUTRAL)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MetricTile("${demo.scansToday}", "testy dziś")
            MetricTile("${demoHistory.count { !it.outcome.successful }}", "nieudane (łącznie)", if (demoHistory.any { !it.outcome.successful }) Tone.WARNING else Tone.NEUTRAL)
        }
        InfoRow("Ostatni udany test", demo.lastSuccessful?.let { formatInstant(it.finishedAt) } ?: "brak")
        demo.lastError?.let { InfoRow("Ostatni błąd testu", it, FlipColors.Danger) }
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
                    schedule.requireWifi -> Tone.WARNING
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
                    colors = FilterChipDefaults.filterChipColors(selectedContainerColor = FlipColors.Gold, selectedLabelColor = FlipColors.OnGold, labelColor = FlipColors.Foreground),
                    border = FilterChipDefaults.filterChipBorder(enabled = true, selected = day in schedule.days, borderColor = FlipColors.MutedForeground),
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

    FlipCard {
        SectionLabel("Wygląd")
        Text("Domyślnie jasny. „Systemowy” przełącza się razem z trybem ciemnym telefonu.", fontSize = 12.sp, color = FlipColors.MutedForeground)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
            ThemeMode.entries.forEach { option ->
                FilterChip(
                    selected = ThemeController.mode == option,
                    onClick = { ThemeController.set(context, option) },
                    label = { Text(option.label) },
                    modifier = Modifier.weight(1f),
                    colors = FilterChipDefaults.filterChipColors(selectedContainerColor = FlipColors.Gold, selectedLabelColor = FlipColors.OnGold, labelColor = FlipColors.Foreground),
                    border = FilterChipDefaults.filterChipBorder(enabled = true, selected = ThemeController.mode == option, borderColor = FlipColors.MutedForeground),
                )
            }
        }
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
private fun GroupsTab(
    synced: List<SyncedGroup>,
    selection: GroupSelection,
    mode: ScanMode,
    lastSync: String?,
    onSelection: (GroupSelection) -> Unit,
    onSync: (String) -> Unit,
    onGroups: (List<SyncedGroup>) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    val context = LocalContext.current
    var syncMessage by remember { mutableStateOf(lastSync) }
    val scope = rememberCoroutineScope()
    val scannable = synced.count { it.scannable }

    if (mode == ScanMode.DEMO) {
        FlipCard(highlighted = true) {
            SectionLabel("Skan demo")
            Text("W trybie demo skan obejmuje tylko grupę testową „${DemoData.group.name}”. Wybór poniżej zadziała po włączeniu skanowania na żywo.", fontSize = 13.sp, color = FlipColors.MutedForeground)
        }
    }

    FlipCard {
        SectionLabel("Synchronizacja z Flip Managerem")
        Text("Lista grup obserwowanych w Flip Managerze. Twój przełącznik „Wyłącz/Włącz” w telefonie zostaje po synchronizacji; grupy usunięte w Flip Managerze są oznaczane i nie są skanowane.", fontSize = 13.sp, color = FlipColors.MutedForeground)
        OutlinedButton(onClick = {
            scope.launch {
                val stamp = ZonedDateTime.now(WARSAW).format(TIME_FORMAT)
                val text = when (val result = WatcherRuntime.groupSource(context).fetch()) {
                    GroupFetchResult.PendingContract -> "$stamp — oczekuje na kontrakt backendu (brak połączenia)"
                    is GroupFetchResult.Failure -> "$stamp — błąd: ${result.code}"
                    is GroupFetchResult.Success -> {
                        val (merged, report) = GroupSync.merge(synced, result.groups) { UUID.randomUUID().toString() }
                        onGroups(merged)
                        "$stamp — dodane ${report.added}, zmienione ${report.updated}, usunięte w Flip Managerze ${report.removedOnServer}"
                    }
                }
                syncMessage = text
                onSync(text)
            }
        }, modifier = Modifier.fillMaxWidth()) { Text("Synchronizuj grupy") }
        syncMessage?.let { Text("Ostatnio: $it", fontSize = 12.sp, color = FlipColors.Warning) }
    }

    FlipCard {
        SectionLabel("Zakres skanu")
        SelectionRow("Wszystkie aktywne", "$scannable z ${synced.size}", selection == GroupSelection.AllActive) { onSelection(GroupSelection.AllActive) }
        if (synced.isNotEmpty()) HorizontalDivider(color = FlipColors.Border)
        synced.forEach { item ->
            val group = item.group
            Column {
                SelectionRow(group.name, group.url, selection == GroupSelection.Single(group.id), enabled = item.scannable) { onSelection(GroupSelection.Single(group.id)) }
                Row(Modifier.padding(start = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                    StatusPill(
                        when (item.origin) {
                            GroupOrigin.LOCAL -> "lokalna"
                            GroupOrigin.SERVER -> if (item.serverEnabled) "Flip Manager" else "wyłączona w Flip Managerze"
                            GroupOrigin.REMOVED_ON_SERVER -> "usunięta w Flip Managerze"
                        },
                        when (item.origin) {
                            GroupOrigin.LOCAL -> Tone.NEUTRAL
                            GroupOrigin.SERVER -> if (item.serverEnabled) Tone.SUCCESS else Tone.WARNING
                            GroupOrigin.REMOVED_ON_SERVER -> Tone.DANGER
                        },
                    )
                    Spacer(Modifier.weight(1f))
                    TextButton(onClick = { onGroups(synced.map { if (it.group.id == group.id) it.copy(group = it.group.copy(active = !it.group.active)) else it }) }) { Text(if (group.active) "Wyłącz" else "Włącz") }
                    TextButton(onClick = { onGroups(synced.filterNot { it.group.id == group.id }) }) { Text("Usuń", color = FlipColors.Danger) }
                }
            }
        }
        if (synced.isEmpty()) Text("Brak grup. Dodaj je poniżej — do czasu synchronizacji lista jest przechowywana tylko w telefonie.", fontSize = 13.sp, color = FlipColors.MutedForeground)
    }

    FlipCard {
        SectionLabel("Dodaj grupę ręcznie")
        OutlinedTextField(name, { name = it }, label = { Text("Nazwa grupy") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(url, { url = it }, label = { Text("Link: https://www.facebook.com/groups/…") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        val normalizedUrl = url.trim().replace(Regex("^https://(m\\.)?facebook\\.com/", RegexOption.IGNORE_CASE), "https://www.facebook.com/")
        val duplicate = synced.any { GroupSync.normalizeUrl(it.group.url) == GroupSync.normalizeUrl(normalizedUrl) }
        if (url.isNotBlank() && !FACEBOOK_SOURCE.matches(url.trim())) Text("Link musi zaczynać się od https://www.facebook.com/", fontSize = 12.sp, color = FlipColors.Danger)
        if (duplicate) Text("Ta grupa już jest na liście.", fontSize = 12.sp, color = FlipColors.Danger)
        Button(
            enabled = name.isNotBlank() && FACEBOOK_SOURCE.matches(url.trim()) && !duplicate,
            onClick = {
                onGroups(synced + SyncedGroup(WatchedGroup(UUID.randomUUID().toString(), name.trim(), normalizedUrl), GroupOrigin.LOCAL))
                name = ""
                url = ""
            },
            colors = ButtonDefaults.buttonColors(containerColor = FlipColors.Gold, contentColor = FlipColors.OnGold),
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Dodaj grupę") }
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
    context: Context,
    store: WatcherSettingsStore,
    liveHistory: List<ScanRecord>,
    demoHistory: List<ScanRecord>,
    diagnostics: List<DiagnosticEvent>,
    conditions: DeviceConditions,
    schedule: ScanSchedule,
    onClearHistory: (ScanMode) -> Unit,
    onClearDiagnostics: () -> Unit,
    onRefreshDiagnostics: () -> Unit,
) {
    val clipboard = LocalClipboardManager.current
    var showDiagnostics by rememberSaveable { mutableStateOf(false) }
    var shownMode by rememberSaveable { mutableStateOf(ScanMode.DEMO) }
    val shown = if (shownMode == ScanMode.LIVE) liveHistory else demoHistory

    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        listOf(ScanMode.LIVE to "Na żywo (${liveHistory.size})", ScanMode.DEMO to "Testy demo (${demoHistory.size})").forEach { (m, label) ->
            FilterChip(
                selected = shownMode == m,
                onClick = { shownMode = m },
                label = { Text(label) },
                modifier = Modifier.weight(1f),
                colors = FilterChipDefaults.filterChipColors(selectedContainerColor = FlipColors.Gold, selectedLabelColor = FlipColors.OnGold, labelColor = FlipColors.Foreground),
                border = FilterChipDefaults.filterChipBorder(enabled = true, selected = shownMode == m, borderColor = FlipColors.MutedForeground),
            )
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        SectionLabel(if (shownMode == ScanMode.LIVE) "Skany prawdziwych grup" else "Skany testowe (oddzielnie od wyników)", Modifier.weight(1f))
        if (shown.isNotEmpty()) TextButton(onClick = { onClearHistory(shownMode) }) { Text("Wyczyść") }
    }
    if (shown.isEmpty()) {
        Text(if (shownMode == ScanMode.LIVE) "Brak — skanowanie na żywo jest wyłączone w tej wersji." else "Brak testów. Uruchom „Skanuj teraz” na Pulpicie.", fontSize = 13.sp, color = FlipColors.MutedForeground)
    }
    shown.forEach { HistoryCard(it) }

    Spacer(Modifier.height(4.dp))
    WorkManagerPanel(context, store, onRefreshDiagnostics)

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
                "Okna: " + store.ledger().take(5).joinToString("; ") { "${it.key} ${it.status} próby=${it.attempts}" },
                "Aktywny dziennik skanu: " + (store.journal()?.let { "${it.scanId} ${it.mode} ${it.completedGroups}/${it.totalGroups}" } ?: "brak"),
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

/** WorkManager state on the phone, without adb: the periodic tick, the probe and the window ledger. */
@Composable
private fun WorkManagerPanel(context: Context, store: WatcherSettingsStore, onRefreshDiagnostics: () -> Unit) {
    val workManager = remember { WorkManager.getInstance(context.applicationContext) }
    val autoInfos by workManager.getWorkInfosForUniqueWorkFlow(WatcherRuntime.AUTO_WORK_NAME).collectAsState(initial = emptyList())
    val probeInfos by workManager.getWorkInfosForUniqueWorkFlow(WatcherRuntime.PROBE_WORK).collectAsState(initial = emptyList())
    LaunchedEffect(probeInfos.firstOrNull()?.state) { onRefreshDiagnostics() }

    FlipCard {
        SectionLabel("WorkManager i okna")
        InfoRow("Automat (co 15 min)", autoInfos.firstOrNull()?.let { workText(it) } ?: "nie zaplanowany")
        InfoRow("Test zadania w tle", probeInfos.firstOrNull()?.let { workText(it) } ?: "nie uruchomiony")
        store.ledger().take(3).forEach { entry ->
            InfoRow("Okno ${windowLabel(entry.key)}", "${windowStatusText(entry.status)} · próby ${entry.attempts}/${WindowLedger.MAX_ATTEMPTS}")
        }
        Text("Test sprawdza, z jakim opóźnieniem Android uruchomi zadanie w tle z warunkami harmonogramu (Wi-Fi, ładowanie). Wynik trafia do diagnostyki jako PROBE_RAN.", fontSize = 12.sp, color = FlipColors.MutedForeground)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { WatcherRuntime.scheduleProbe(context, 1); onRefreshDiagnostics() }, modifier = Modifier.weight(1f)) { Text("Test za 1 min") }
            OutlinedButton(onClick = { WatcherRuntime.scheduleProbe(context, 15); onRefreshDiagnostics() }, modifier = Modifier.weight(1f)) { Text("Test za 15 min") }
        }
    }
}

private fun workText(info: WorkInfo): String = buildString {
    append(when (info.state) {
        WorkInfo.State.ENQUEUED -> "czeka"
        WorkInfo.State.RUNNING -> "działa"
        WorkInfo.State.SUCCEEDED -> "wykonane"
        WorkInfo.State.FAILED -> "błąd"
        WorkInfo.State.BLOCKED -> "zablokowane"
        WorkInfo.State.CANCELLED -> "anulowane"
    })
    if (info.state == WorkInfo.State.ENQUEUED && info.nextScheduleTimeMillis != Long.MAX_VALUE) {
        append(", najwcześniej ").append(Instant.ofEpochMilli(info.nextScheduleTimeMillis).atZone(WARSAW).format(TIME_FORMAT))
    }
    if (info.runAttemptCount > 0) append(", próby ").append(info.runAttemptCount)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && info.stopReason != WorkInfo.STOP_REASON_NOT_STOPPED) append(", stop ").append(info.stopReason)
}

/** Window keys are the window start as an ISO offset date-time, e.g. 2026-10-15T02:00+02:00. */
private fun windowLabel(key: String): String = runCatching { OffsetDateTime.parse(key).atZoneSameInstant(WARSAW).format(TIME_FORMAT) }.getOrDefault(key)

private fun windowStatusText(status: WindowStatus) = when (status) {
    WindowStatus.STARTED -> "skan w toku"
    WindowStatus.FINISHED -> "wykorzystane (skan zakończony)"
    WindowStatus.INTERRUPTED -> "przerwane"
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
    ScanOutcome.PARTIAL, ScanOutcome.STOPPED, ScanOutcome.TIMED_OUT, ScanOutcome.INTERRUPTED -> Tone.WARNING
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
