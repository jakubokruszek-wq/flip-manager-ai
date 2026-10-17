package pl.jakubokruszek.flipcollector.watcher.android

import android.content.Intent
import android.os.Bundle
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import kotlinx.coroutines.*
import pl.jakubokruszek.flipcollector.collector.LiveCollectionGate

/** No intent/deep-link can approve or start a scan. Consent exists only in this UI. */
class LivePilotActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MaterialTheme { Surface { PilotScreen(this) } } }
    }
}

@Composable
private fun PilotScreen(activity: LivePilotActivity) {
    val scope = rememberCoroutineScope()
    val state = remember { LivePilotRuntime.journal(activity) }
    val host = remember { FrameLayout(activity) }
    var snapshot by remember { mutableStateOf(state.diagnostics()) }
    var raw by remember { mutableStateOf("") }
    var sessionConsent by remember { mutableStateOf(false) }
    var scanConsent by remember { mutableStateOf(false) }
    var browser by remember { mutableStateOf<WebViewCollectorBrowser?>(null) }
    var task by remember { mutableStateOf<Job?>(null) }
    var used by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    var webViewStatus by remember { mutableStateOf("NOT_OPENED") }
    var blockedCount by remember { mutableIntStateOf(0) }
    fun close() {
        task?.cancel()
        host.removeAllViews()
        browser?.close()
        browser = null
        scanConsent = false
        webViewStatus = "SESSION_CLOSED"
        blockedCount = 0
    }
    fun newBrowser(): WebViewCollectorBrowser {
        check(LivePilotRuntime.available() && sessionConsent)
        val source = LivePilotRuntime.profile(activity).source
        return WebViewCollectorBrowser(activity, LiveCollectionGate(true, true), pilotSource = source,
            onViewCreated = { host.removeAllViews(); host.addView(it) }).also { it.onDiagnostic = { status -> webViewStatus = status } }
    }
    DisposableEffect(activity) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE) {
                task?.cancel(CancellationException("PILOT_FOREGROUND_LOST"))
                browser?.currentView()?.stopLoading()
            }
        }
        activity.lifecycle.addObserver(observer)
        onDispose { activity.lifecycle.removeObserver(observer); close() }
    }
    LaunchedEffect(Unit) { while (isActive) { snapshot = state.diagnostics(); blockedCount = browser?.blockedResourceCount() ?: 0; delay(1000) } }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Test LIVE — 1 grupa", style = MaterialTheme.typography.headlineSmall)
        Text("LIVE PILOT · maks. 20 postów · ekran włączony · bez Vision i galerii")
        Text("DEMO i OFFLINE_TEST mają osobne przebiegi. Ten ekran nie uruchamia harmonogramu LIVE.")
        if (!LivePilotRuntime.available()) Text("BLOKADA: pilot jest wyłączony w tym APK. Otwarcie Facebooka wymaga osobno zatwierdzonego buildu i testowego API bez zapisu do Findera.")
        OutlinedTextField(raw, { raw = it }, label = { Text("Prywatny profil pilota (ważny 1 godzinę)") },
            visualTransformation = PasswordVisualTransformation(), maxLines = 2)
        Button(enabled = LivePilotRuntime.available() && task?.isActive != true && browser == null, onClick = {
            message = runCatching { LivePilotRuntime.configure(activity, raw); raw = ""; "Profil zapisany" }.getOrElse { "Profil odrzucony; sprawdź origin, termin i oczekujące zadanie" }
        }) { Text("Zapisz profil testowy") }
        if (LivePilotRuntime.available() && snapshot.optBoolean("configured")) {
            Text(runCatching { "Zatwierdzana grupa: " + LivePilotRuntime.profile(activity).source.url }.getOrDefault("Profil wygasł"))
        }
        Row {
            Checkbox(sessionConsent, { sessionConsent = it; if (!it) close() })
            Text("Zgadzam się na interaktywną sesję Facebooka na tym telefonie.")
        }
        Button(enabled = LivePilotRuntime.available() && sessionConsent && browser == null && task?.isActive != true, onClick = {
            runCatching {
                browser = newBrowser()
                browser!!.open(LivePilotRuntime.profile(activity).source.url)
                used = false
                message = "Sesja otwarta. Login wykonujesz samodzielnie; checkpoint/CAPTCHA oznacza STOP."
            }.onFailure { close(); message = "Nie można otworzyć sesji; sprawdź profil i ekran" }
        }) { Text("Otwórz sesję za zgodą") }
        // Facebook's public group header may use a popup link. Navigate explicitly
        // to Facebook's own HTTPS login page in this SAME WebView on user action.
        OutlinedButton(enabled = browser != null && sessionConsent && task?.isActive != true, onClick = {
            message = runCatching {
                requireNotNull(browser).openLogin()
                "Logowanie otwarte w Watcherze. Wpisuj dane wyłącznie na facebook.com; przy checkpoint/CAPTCHA zatrzymaj próbę."
            }.getOrElse { "Nie można otworzyć strony logowania. STOP i zgłoś błąd." }
        }) { Text("Zaloguj się na Facebooku w Watcherze") }
        OutlinedButton(enabled = browser != null && sessionConsent && task?.isActive != true, onClick = {
            message = runCatching {
                requireNotNull(browser).open(LivePilotRuntime.profile(activity).source.url)
                "Powrót do zatwierdzonej grupy. Skan dostępny tylko na jej stronie."
            }.getOrElse { "Nie udało się wrócić do grupy. STOP i zgłoś błąd." }
        }) { Text("Wróć do zatwierdzonej grupy") }
        AndroidView(factory = { host }, modifier = Modifier.fillMaxWidth().height(if (browser != null) 420.dp else 1.dp))
        Text("Diagnostyka WebView (bez adresów i danych logowania): $webViewStatus")
        Text("Zablokowane zasoby strony: $blockedCount")
        Row {
            Checkbox(scanConsent, { scanConsent = it })
            Text("Zatwierdzam jeden skan powyższej grupy (maks. 20 postów) do izolowanego API.")
        }
        Button(enabled = browser?.documentReady() == true && scanConsent && !used && task?.isActive != true && !snapshot.optBoolean("pending") && !snapshot.optBoolean("active"), onClick = {
            used = true
            task = scope.launch {
                try { LivePilotRuntime.run(activity, requireNotNull(browser), sessionConsent && scanConsent); message = "Przebieg zakończony; sprawdź receipt" }
                catch (cancelled: CancellationException) { message = "STOP; stan odzyskiwania zachowany"; throw cancelled }
                catch (_: Exception) { message = "STOP; sprawdź kod i outbox" }
                finally { host.removeAllViews(); browser?.close(); browser = null; scanConsent = false }
            }
        }) { Text("Skanuj raz — maks. 20") }
        OutlinedButton(onClick = { task?.cancel(); message = "STOP na żądanie operatora" }) { Text("STOP") }
        OutlinedButton(enabled = LivePilotRuntime.available() && sessionConsent && task?.isActive != true && (snapshot.optBoolean("pending") || snapshot.optBoolean("active")), onClick = {
            task = scope.launch {
                try {
                    LivePilotRuntime.run(activity, browser ?: newBrowser(), sessionConsent, retryOnly = true)
                    message = "Odzyskiwanie zakończone; bez otwierania Facebooka"
                } catch (_: Exception) { message = "Odzyskiwanie zatrzymane; outbox zachowany" }
            }
        }) { Text("Ponów potwierdzenie — bez skanu") }
        Text("Sesja: ${if (browser != null) "otwarta" else "zamknięta"} · widoczne: ${snapshot.optInt("visible")} · zweryfikowane: ${snapshot.optInt("verified")}")
        Text("Outbox: ${snapshot.optBoolean("pending")} · aktywny lease: ${snapshot.optBoolean("active")} · receipts: ${snapshot.optInt("receipts")}")
        val start = snapshot.optLong("startedAt")
        val end = snapshot.optLong("finishedAt").takeIf { it >= start } ?: System.currentTimeMillis()
        Text("Czas: ${if (start > 0) (end - start) / 1000 else 0}s · ostatni heartbeat: ${snapshot.optLong("heartbeat")}")
        Text("Przyczyna STOP: ${snapshot.optString("stop").ifBlank { "brak" }}")
        Text(message)
        OutlinedButton(onClick = {
            activity.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, state.diagnostics().toString(2)), "Eksport zanonimizowanej diagnostyki"))
        }) { Text("Eksport diagnostyki") }
        OutlinedButton(onClick = { close(); activity.finish() }) { Text("Zamknij pilota") }
    }
}
