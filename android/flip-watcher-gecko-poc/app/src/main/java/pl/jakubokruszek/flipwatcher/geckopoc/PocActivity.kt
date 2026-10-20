package pl.jakubokruszek.flipwatcher.geckopoc

import android.Manifest
import android.app.AlarmManager
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import org.mozilla.geckoview.AllowOrDeny
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoSessionSettings
import org.mozilla.geckoview.GeckoView
import org.mozilla.geckoview.StorageController
import org.mozilla.geckoview.WebExtension
import org.mozilla.geckoview.WebRequestError
import java.time.Instant
import java.util.UUID

/**
 * Flip Watcher — Gecko POC. One screen: an explicit-consent GeckoView session
 * limited to the approved test group, manual login on Facebook's own page,
 * page diagnostics, a single operator-started scan and the local screen-off
 * test. Nothing runs on its own and nothing is uploaded.
 */
class PocActivity : ComponentActivity() {
    private lateinit var geckoView: GeckoView
    private lateinit var banner: TextView
    private lateinit var diagnostics: TextView
    private lateinit var output: TextView
    private val buttons = mutableMapOf<String, Button>()

    private var session: GeckoSession? = null
    private var channel: CollectorChannel? = null
    private var extension: WebExtension? = null
    private var extensionError: String? = null

    private var url: String? = null
    private var kind = PageKind.BLANK
    private var progress = 0
    private var title: String? = null
    private var userAgent: String? = null
    private var lastLoadError: String? = null
    private var blockedNavigations = 0
    private var lastBlockedHost: String? = null
    private var probe: PageProbe? = null
    private var loginRequested = false
    private var scanning = false
    private var visibleEpoch = 0L
    private var visibleBusy = false
    private var responseBusy = false
    private val responseReloadGate = ResponseReloadGate()
    private var visibleDialog: AlertDialog? = null
    private var inspectingDom = false
    private var haltMessage: String? = null
    /** Last top-level navigations (sanitized), the evidence for "Diagnoza grupy". */
    private val navTrace = ArrayDeque<NavStep>()

    private val preferences by lazy { getSharedPreferences("gecko_poc", MODE_PRIVATE) }
    private val store by lazy { ScreenOffTest.store(this) }
    /** Last device measurements, combined into the GO / CONDITIONAL GO / NO-GO verdict. */
    private var lastControl: ControlStatus? = null
    private var lastStructure: StructureDiagnosis? = null
    private var measuringLoad = false

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { scheduleScreenOffTest() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildLayout())
        lifecycleScope.launch {
            extension = runCatching { GeckoHost.collectorExtension(this@PocActivity) }
                .onFailure { extensionError = it.javaClass.simpleName + ": " + (it.message ?: "").take(80) }
                .getOrNull()
            render()
        }
        render()
    }

    override fun onDestroy() {
        closeSession()
        super.onDestroy()
    }

    override fun onPause() {
        stopVisiblePosts()
        super.onPause()
    }

    private fun stopVisiblePosts() {
        responseReloadGate.cancel()
        channel?.abortResponseDiagnosis()
        GeckoHost.background.abortResponses()
        responseBusy = false
        visibleEpoch++
        visibleBusy = false
        visibleDialog?.dismiss()
        visibleDialog = null
        if (::output.isInitialized) output.text = ""
    }

    private fun checkVisiblePosts() {
        if (visibleBusy || responseBusy || scanning || inspectingDom || kind != PageKind.APPROVED_GROUP || progress < 100 || haltMessage != null) return
        val current = channel ?: return
        val epoch = visibleEpoch
        val approvedUrl = url
        visibleDialog = AlertDialog.Builder(this)
            .setTitle("Nowa zgoda: widoczne posty")
            .setMessage("Jednorazowo przeanalizować wyrenderowany DOM tej grupy? Maksymalnie 20 widocznych kandydatów i do 6 poziomów otaczających kontenerów. Sprawdzane są też jawne atrybuty adresów przy tych blokach, maksymalnie 200 elementów. Bez odczytu kodu kliknięć i ukrytych danych akcji. Wspólny feed nie jest przypisywany do posta. Tylko lokalne liczniki: linki, dokładne ID, cena, metraż, pokoje, dzielnica i zdjęcia. Pola są heurystyczne. Bez zapisu treści, bez sieciowych odpowiedzi, bez skanu i kolektora. Zgoda wygasa po tej próbie.")
            .setNegativeButton("Anuluj", null)
            .setPositiveButton("Zgadzam się jednorazowo") { _, _ ->
                if (epoch != visibleEpoch || current !== channel || approvedUrl != url || kind != PageKind.APPROVED_GROUP) return@setPositiveButton
                visibleBusy = true
                lifecycleScope.launch {
                    val report = runCatching { current.visiblePosts(consent = true) }.getOrNull()
                    if (epoch == visibleEpoch && current === channel && approvedUrl == url && kind == PageKind.APPROVED_GROUP) {
                        output.text = report ?: "STOP: brak poprawnego kontekstu lub przerwana diagnostyka."
                        visibleBusy = false
                    }
                }
            }.show()
    }

    private fun checkResponses(autoScroll: Boolean = false) {
        if (responseBusy || visibleBusy || scanning || inspectingDom || measuringLoad || kind != PageKind.APPROVED_GROUP || progress < 100 || haltMessage != null) return
        val current = channel ?: return
        val epoch = visibleEpoch
        val approvedUrl = url
        visibleDialog = AlertDialog.Builder(this)
            .setTitle(if (autoScroll) "Nowa zgoda: odpowiedzi i przewijanie" else "Nowa zgoda: treść odpowiedzi sieciowych")
            .setMessage((if (autoScroll) "ZEZWOLIĆ NA AUTOMATYCZNE PRZEWIJANIE? Maksymalnie 5 kroków po 400–900 px, pierwszy po 1 s, następne co 2 s; łącznie do 4500 px. Tylko okno diagnostyki 15 s, bez klikania, skanu i kolektora. " else "Bez automatycznego przewijania. ") + "Przez 15 sekund analizować lokalnie odpowiedzi danych tej zatwierdzonej grupy? Dodatkowo policzyć zdarzenia Facebook/CDN i powody pominięcia (karta, ramka, typ, host, ścieżka, kontekst), także zbiorczo ruch bez karty lub innej karty, bez jego treści i adresów? Do 8 odpowiedzi, 512 KiB na odpowiedź i 2 MiB łącznie, maksymalnie 20 dokładnych ID. Tylko pamięć i liczniki: bez zapisu surowych odpowiedzi, tekstów, ID, cookies i tokenów; bez uploadu, skanu, galerii i kolektora. Strona otrzyma niezmienione bajty. Możesz ręcznie przewinąć grupę. Zmiana strony, LOGIN/CAPTCHA/CHECKPOINT i wygaszenie przerywają próbę. To osobna zgoda, niezależna od DOM i starego skanu.")
            .setNegativeButton("Anuluj", null)
            .setPositiveButton("Zgadzam się jednorazowo") { _, _ ->
                if (epoch != visibleEpoch || current !== channel || approvedUrl != url || kind != PageKind.APPROVED_GROUP) return@setPositiveButton
                responseBusy = true
                output.text = if (autoScroll) "Diagnostyka: 15 sekund, do 5 automatycznych przewinięć. Zmiana kontekstu lub wygaszenie: STOP." else "Diagnostyka odpowiedzi: 15 sekund. Możesz ręcznie przewinąć zatwierdzoną grupę."
                render()
                lifecycleScope.launch {
                    val report = runCatching { current.responseDiagnosis(consent = true, autoScrollConsent = autoScroll) }.getOrNull()
                    if (epoch == visibleEpoch && current === channel && approvedUrl == url && kind == PageKind.APPROVED_GROUP) {
                        output.text = report ?: "STOP: przerwana diagnostyka odpowiedzi."
                        responseBusy = false
                        render()
                    }
                }
            }.show()
    }

    private fun checkResponseLoad(autoScroll: Boolean = false) {
        if (responseBusy || visibleBusy || scanning || inspectingDom || measuringLoad || kind != PageKind.APPROVED_GROUP || progress < 100 || haltMessage != null) return
        val currentSession = session ?: return
        val current = channel ?: return
        val approvedUrl = url ?: return
        val epoch = visibleEpoch
        visibleDialog = AlertDialog.Builder(this).setTitle(if (autoScroll) "Nowa zgoda: otwarcie + przewijanie" else "Nowa zgoda: jedno otwarcie i odpowiedzi")
            .setMessage((if (autoScroll) "ZEZWOLIĆ TAKŻE NA AUTOMATYCZNE PRZEWIJANIE? Do 5 kroków po 400–900 px, maksymalnie 4500 px. Pierwszy po sprawdzeniu nowego dokumentu i 1 s, kolejne co 2 s. Przeładowanie i przewijanie dzielą JEDNO okno do 25 s; wolne ładowanie zmniejsza liczbę kroków. " else "Bez automatycznego przewijania. ") + "Otworzyć ponownie DOKŁADNIE tę zatwierdzoną grupę w tej samej karcie i przez 25 s odczytywać lokalnie jej odpowiedzi danych? Obejmuje typy XHR, fetch i other, wyłącznie dozwolone endpointy, top-frame i dokładny kontekst grupy. Osobno policzyć dokładne typy zasobów (w tym ping/beacon), klasy /ajax/bz, inne /ajax i /data oraz zgodność ramki/origin? To wyłącznie liczniki metadanych, bez odczytu treści dodatkowych typów. To nowy zakres, niezależny od skanu i przewijania. Do 8 odpowiedzi, 512 KiB na odpowiedź, 2 MiB łącznie i 20 ID. Wcześniejsze odpowiedzi pozostaną w ograniczonej pamięci RAM do sprawdzenia nowego dokumentu; bez potwierdzenia zostaną usunięte bez analizy postów. Bez odczytu dokumentu HTML, nagłówków, cookies i tokenów, zapisu, uploadu, skanu i kolektora. Tylko jedno zatwierdzone otwarcie; kolejne przejście, LOGIN/CAPTCHA/CHECKPOINT, pauza, wygaszenie lub utrata kontekstu: STOP.")
            .setNegativeButton("Anuluj", null).setPositiveButton("Zgadzam się jednorazowo") { _, _ ->
                if (epoch != visibleEpoch || current !== channel || currentSession !== session || approvedUrl != url || kind != PageKind.APPROVED_GROUP) return@setPositiveButton
                responseReloadGate.begin(approvedUrl); responseBusy = true
                output.text = "Odpowiedzi od otwarcia: 25 s, jedno zatwierdzone otwarcie. Nie dotykaj ekranu."
                render()
                lifecycleScope.launch {
                    val report = runCatching { ResponseLoadRunner(GeckoHost.background).run(currentSession, current, approvedUrl,
                        PocPolicy.APPROVED_GROUP_ID, autoScrollConsent = autoScroll, alive = { epoch == visibleEpoch && currentSession === session && responseReloadGate.active },
                        willLoad = { responseReloadGate.willLoad() }) }.getOrNull()
                    if (epoch == visibleEpoch && currentSession === session && responseReloadGate.active) {
                        responseReloadGate.cancel(); responseBusy = false
                        output.text = report ?: "STOP: brak potwierdzonego nowego dokumentu lub przerwana próba."
                        render()
                    }
                }
            }.show()
    }

    // ---- session

    private fun askConsentAndOpen() {
        if (preferences.getBoolean(KEY_CONSENT, false)) { openSession(); return }
        AlertDialog.Builder(this)
            .setTitle("Zgoda na sesję Facebooka")
            .setMessage(
                "Otworzy się zwykła przeglądarka (silnik Firefox/GeckoView) tylko dla zatwierdzonej grupy testowej.\n\n" +
                    "• Logujesz się sam na oficjalnej stronie Facebooka; aplikacja nie czyta haseł ani pól formularzy.\n" +
                    "• Sesja (ciasteczka) zostaje wyłącznie w tej aplikacji na telefonie; możesz ją usunąć przyciskiem „Wyloguj i usuń dane”.\n" +
                    "• Nic nie jest wysyłane do Flip Managera; skan uruchamiasz ręcznie i zapisuje tylko identyfikatory postów lokalnie.\n" +
                    "• Przy CAPTCHA, checkpoincie lub utracie dostępu automat staje.",
            )
            .setPositiveButton("Zgadzam się") { _, _ -> preferences.edit().putBoolean(KEY_CONSENT, true).apply(); openSession() }
            .setNegativeButton("Anuluj", null)
            .show()
    }

    private fun openSession() {
        if (session != null) return
        val ext = extension ?: run { output.text = "Rozszerzenie kolektora nie jest gotowe: ${extensionError ?: "instalacja w toku"}"; return }
        // Default settings: normal mobile Firefox user agent, JavaScript and cookies as in the browser. No override, no spoofing.
        val newSession = GeckoSession(GeckoSessionSettings.Builder().build())
        val newChannel = CollectorChannel(newSession, fixtureMode = false, onVisibleStop = { stopVisiblePosts() }, onPageDisconnect = { if (!responseReloadGate.allowOldDisconnect()) stopVisiblePosts() }, onPageConnected = { responseReloadGate.connected() }) { value -> probe = value; render() }
        newChannel.attach(ext)
        newSession.progressDelegate = progressDelegate
        newSession.contentDelegate = contentDelegate
        newSession.navigationDelegate = navigationDelegate
        newSession.open(GeckoHost.runtime(this))
        geckoView.setSession(newSession)
        session = newSession
        channel = newChannel
        haltMessage = null
        navTrace.clear()
        lifecycleScope.launch { userAgent = runCatching { newSession.userAgent.await() }.getOrNull(); render() }
        load(PocPolicy.APPROVED_GROUP_URL, login = false)
    }

    private fun closeSession() {
        stopVisiblePosts()
        channel?.close()
        channel = null
        session?.let { current ->
            runCatching { geckoView.releaseSession() }
            runCatching { current.close() }
        }
        session = null
        url = null
        kind = PageKind.BLANK
        probe = null
        progress = 0
        scanning = false
        loginRequested = false
        if (::banner.isInitialized) render()
    }

    private fun load(target: String, login: Boolean) {
        val current = session ?: return
        loginRequested = login
        haltMessage = null
        current.loadUri(target)
    }

    private fun clearSessionData() {
        AlertDialog.Builder(this)
            .setTitle("Wylogować i usunąć dane sesji?")
            .setMessage("Usunie ciasteczka, pamięć stron i pamięć podręczną tej aplikacji. Konto na Facebooku nie jest zmieniane.")
            .setPositiveButton("Usuń") { _, _ ->
                closeSession()
                lifecycleScope.launch {
                    val ok = runCatching { GeckoHost.runtime(this@PocActivity).storageController.clearData(StorageController.ClearFlags.ALL).await() }.isSuccess
                    output.text = if (ok) "Dane sesji usunięte." else "Nie udało się usunąć danych sesji."
                }
            }
            .setNegativeButton("Anuluj", null)
            .show()
    }

    // ---- scan

    private fun scan(scrolls: Int) {
        val current = channel ?: return
        if (scanning || preferences.getBoolean(KEY_ONE_SCAN_USED, false)) return
        val started = Instant.now().toString()
        // Record one-shot consent AND the pending attempt in a single durable commit.
        // Never reset this permission merely because scanning failed.
        val permitted = preferences.edit()
            .putBoolean(KEY_ONE_SCAN_USED, true)
            .putString(KEY_ATTEMPT_STAGE, "STARTED")
            .putString(KEY_ATTEMPT_AT, started)
            .putString(KEY_ATTEMPT_STATUS, "PENDING")
            .putInt(KEY_ATTEMPT_POSTS, 0)
            .putInt(KEY_ATTEMPT_REJECTED, 0)
            .putString(KEY_ATTEMPT_ERROR, "")
            .putString(KEY_ATTEMPT_SAVE_ERROR, "")
            .commit()
        if (!permitted) {
            output.text = "STOP: nie udało się zapisać rozpoczęcia próby. Żądanie NIE zostało wysłane."
            render()
            return
        }
        // Fail closed if the initial local result journal cannot be written.
        val journal = runCatching { store.append(StoredRun("GROUP_SCAN_ATTEMPT", started, started,
            "STARTED", emptyList(), emptyList(), 0, mapOf("source" to PocPolicy.APPROVED_GROUP_ID, "scrolls" to scrolls.toString()))) }
        if (journal.isFailure) {
            val reason = journal.exceptionOrNull()?.javaClass?.simpleName ?: "UNKNOWN"
            preferences.edit().putString(KEY_ATTEMPT_STAGE, "ABORTED")
                .putString(KEY_ATTEMPT_STATUS, "NO_REQUEST_SENT")
                .putString(KEY_ATTEMPT_ERROR, "START_WRITE_FAILED:$reason").commit()
            output.text = "STOP: nie zapisano początku skanu ($reason). Żądanie NIE zostało wysłane. Limit pozostaje wykorzystany."
            render()
            return
        }
        scanning = true
        render()
        lifecycleScope.launch {
            try {
                val report = current.scan(ScanRequest(nonce = UUID.randomUUID().toString(), scrolls = scrolls))
                if (report.status.haltsAutomation) haltMessage = "STOP: ${report.status} — automat wstrzymany do decyzji operatora."
                val notes = mapOf(
                    "source" to PocPolicy.APPROVED_GROUP_ID,
                    "scrolls" to report.scrolls.toString(),
                    "visibleCards" to (report.diagnostics["visibleCards"] ?: 0).toString(),
                    "cardsWithoutId" to (report.diagnostics["cardsWithoutId"] ?: 0).toString(),
                    "ambiguousCards" to (report.diagnostics["ambiguousCards"] ?: 0).toString(),
                    "foreignCards" to (report.diagnostics["foreignCards"] ?: 0).toString())
                val saved = runCatching { store.append(PocResultStore.fromReport("GROUP_SCAN", started, Instant.now().toString(), report, notes)) }
                val saveError = saved.exceptionOrNull()?.javaClass?.simpleName.orEmpty()
                val persisted = preferences.edit()
                    .putString(KEY_ATTEMPT_STAGE, "FINISHED")
                    .putString(KEY_ATTEMPT_STATUS, report.status.name)
                    .putInt(KEY_ATTEMPT_POSTS, report.posts.size)
                    .putInt(KEY_ATTEMPT_REJECTED, report.rejectedByApp)
                    .putString(KEY_ATTEMPT_ERROR, if (report.error.isNullOrBlank()) "" else "SCAN_RESPONSE_ERROR")
                    .putString(KEY_ATTEMPT_SAVE_ERROR, if (saveError.isEmpty()) "" else "RESULT_WRITE_FAILED:$saveError")
                    .commit()
                output.text = describe(report) + when {
                    !persisted -> "\nUWAGA: nie udało się zachować trwałego podsumowania próby."
                    saveError.isNotEmpty() -> "\nUWAGA: błąd zapisu historii ($saveError); liczby zachowano osobno."
                    else -> "\nWynik zapisany lokalnie — użyj „Wyniki”."
                }
            } catch (e: Exception) {
                // Show only the exception class: no page text, credentials or URLs.
                val reason = e.javaClass.simpleName.take(60)
                val result = if (e is kotlinx.coroutines.CancellationException) "INTERRUPTED" else "EXCEPTION"
                val saved = runCatching { store.append(StoredRun("GROUP_SCAN", started, Instant.now().toString(),
                    result, emptyList(), emptyList(), 0, mapOf("errorClass" to reason))) }
                preferences.edit()
                    .putString(KEY_ATTEMPT_STAGE, "ABORTED")
                    .putString(KEY_ATTEMPT_STATUS, result)
                    .putString(KEY_ATTEMPT_ERROR, reason)
                    .putString(KEY_ATTEMPT_SAVE_ERROR,
                        if (saved.isSuccess) "" else "RESULT_WRITE_FAILED:${saved.exceptionOrNull()?.javaClass?.simpleName}")
                    .commit()
                output.text = "STOP: skan nieukończony ($result, $reason). Limit pozostaje wykorzystany."
                if (e is kotlinx.coroutines.CancellationException) throw e
            } finally {
                scanning = false
                render()
            }
        }
    }

    private fun describe(report: ScanReport): String = buildString {
        appendLine("Skan: ${report.status}  •  postów: ${report.posts.size}  •  odrzucone przez aplikację: ${report.rejectedByApp}  •  przewinięcia: ${report.scrolls}")
        report.error?.let { appendLine("Błąd: $it") }
        if (report.diagnostics.isNotEmpty()) appendLine("Kolektor: " + report.diagnostics.entries.joinToString { "${it.key}=${it.value}" })
        report.posts.forEachIndexed { index, post -> appendLine("${index + 1}. ${post.postId}  [${post.idSource}]  ${post.permalink}") }
    }

    private fun scanAttemptSummary(): String = ScanAttemptJournal.summary(
        consumed = preferences.getBoolean(KEY_ONE_SCAN_USED, false),
        stage = preferences.getString(KEY_ATTEMPT_STAGE, null),
        status = preferences.getString(KEY_ATTEMPT_STATUS, null),
        posts = preferences.getInt(KEY_ATTEMPT_POSTS, 0),
        rejected = preferences.getInt(KEY_ATTEMPT_REJECTED, 0),
        startedAt = preferences.getString(KEY_ATTEMPT_AT, null),
        error = preferences.getString(KEY_ATTEMPT_ERROR, null),
        saveError = preferences.getString(KEY_ATTEMPT_SAVE_ERROR, null),
    )

    private fun showResults() {
        val runs = store.runs()
        // Prioritize the real scan outcome above verbose older group diagnoses.
        val scans = runs.filter { it.kind.startsWith("GROUP_SCAN") }
        val other = runs.filterNot { it.kind.startsWith("GROUP_SCAN") }
        output.text = buildString {
            appendLine(scanAttemptSummary())
            appendLine()
            if (scans.isEmpty()) appendLine("Brak zapisanego GROUP_SCAN. Sam limit jednorazowy NIE potwierdza odczytu postów.")
            else {
                appendLine("HISTORIA PRÓB SKANOWANIA:")
                scans.take(5).forEach { run ->
                    appendLine("${run.kind}: ${run.status} • ${run.postIds.size} postów • odrzucone ${run.rejectedByApp}")
                    appendLine("${run.startedAt} → ${run.finishedAt}")
                    if (run.notes.isNotEmpty()) appendLine(run.notes.entries.joinToString { "${it.key}=${it.value}" })
                    appendLine()
                }
            }
            if (other.isNotEmpty()) {
                appendLine("INNE DIAGNOZY:")
                other.take(3).forEach { run -> appendLine("${run.kind}: ${run.status} • ${run.startedAt}") }
            }
        }
    }

    // ---- current-page diagnostics: no post scan, permission or upload
    private fun inspectDom() {
        if (responseBusy || scanning || inspectingDom) return
        val current = channel ?: run { output.text = "Otwórz sesję."; return }
        if (kind != PageKind.APPROVED_GROUP || !current.isConnected) {
            output.text = "Diagnoza postów dostępna tylko na zatwierdzonej grupie z połączonym rozszerzeniem."
            return
        }
        inspectingDom = true
        render()
        output.text = "Diagnoza postów: okno ${ScanProtocol.DIAGNOSIS_WINDOW_MS / 1000} s — przewijaj teraz powoli posty grupy.\n" +
            "Liczone są tylko zdarzenia żądań tej karty; treść odpowiedzi nie jest czytana. Bez skanu."
        lifecycleScope.launch {
            val started = Instant.now().toString()
            try {
                val result = current.structureDiagnosis()
                if (result == null) {
                    output.text = "Diagnoza postów: brak odpowiedzi z rozszerzenia. Skan NIE został uruchomiony."
                } else {
                    lastStructure = result
                    output.text = StructureReport.describe(result) + "\n\n" + verdictText()
                    // Counters only, so the operator can copy the result from "Wyniki".
                    runCatching {
                        store.append(StoredRun("STRUCTURE_DIAGNOSIS", started, Instant.now().toString(), result.verdict ?: result.status,
                            emptyList(), emptyList(), 0, result.counts.filterValues { it != 0 }.mapValues { it.value.toString() } +
                                ("attributeNames" to result.attributeNames.joinToString { "${it.first}×${it.second}" }) +
                                ("numericAttributes" to result.numericAttributes.joinToString { "${it.first}×${it.second}" }) +
                                ("requestPaths" to result.requestPaths.joinToString { "${it.first}×${it.second}" })))
                    }
                }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                output.text = "Diagnoza postów: błąd ${e.javaClass.simpleName}. Bez skanu."
            } finally {
                inspectingDom = false
                render()
            }
        }
    }

    // ---- one measured load of the approved group (counts only, armed before loadUri)
    private fun measureGroupOpening() {
        if (responseBusy || measuringLoad || scanning || inspectingDom) return
        val current = session ?: run { output.text = "Otwórz sesję."; return }
        val currentChannel = channel ?: return
        measuringLoad = true
        inspectingDom = true
        loginRequested = false
        haltMessage = null
        render()
        output.text = "Zmierz otwarcie grupy: nasłuch uzbrojony PRZED otwarciem, okno ${LoadMeasurement.WINDOW_MS / 1000} s. Nie dotykaj ekranu.\n" +
            "Liczone są tylko zdarzenia sieci tej karty; treść odpowiedzi nie jest czytana. Bez skanu."
        lifecycleScope.launch {
            val started = Instant.now().toString()
            try {
                GeckoHost.collectorExtension(this@PocActivity)
                val result = LoadMeasurementRunner(GeckoHost.background).run(
                    session = current,
                    channel = currentChannel,
                    url = PocPolicy.APPROVED_GROUP_URL,
                    groupId = PocPolicy.APPROVED_GROUP_ID,
                    sessionAlive = { session === current },
                )
                output.text = LoadMeasurement.describe(result)
                runCatching {
                    store.append(StoredRun("GROUP_LOAD_MEASUREMENT", started, Instant.now().toString(),
                        result.status.name + (result.reason?.let { ":$it" } ?: ""), emptyList(), emptyList(), 0,
                        (result.counts + result.dom.orEmpty()).filterValues { it != 0 }.mapValues { it.value.toString() } +
                            ("requestPaths" to result.requestPaths.joinToString { "${it.first}×${it.second}" })))
                }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                output.text = "Zmierz otwarcie grupy: błąd ${e.javaClass.simpleName}. Pomiar przerwany i wyczyszczony."
            } finally {
                measuringLoad = false
                inspectingDom = false
                render()
            }
        }
    }

    // ---- listener control test (local page, own session, no Facebook)
    private fun runNetworkControl() {
        if (responseBusy || scanning || inspectingDom) return
        inspectingDom = true
        render()
        output.text = "Test sieci GeckoView: lokalna strona 127.0.0.1 w osobnej sesji (ok. 5 s). Bez Facebooka."
        lifecycleScope.launch {
            val started = Instant.now().toString()
            try {
                val result = NetworkControlRunner(this@PocActivity).run()
                lastControl = result.status
                output.text = NetworkControl.describe(result) + "\n\n" + verdictText()
                runCatching {
                    store.append(StoredRun("NETWORK_CONTROL", started, Instant.now().toString(), result.status.name,
                        emptyList(), emptyList(), 0, result.counts.filterValues { it != 0 }.mapValues { it.value.toString() }))
                }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                lastControl = ControlStatus.TIMEOUT
                output.text = "Test sieci GeckoView: błąd ${e.javaClass.simpleName} → TIMEOUT."
            } finally {
                inspectingDom = false
                render()
            }
        }
    }

    private fun verdictText(): String {
        val verdict = ArchitectureVerdict.decide(lastControl, lastStructure)
        return "WERDYKT ARCHITEKTURY: ${verdict.decision} — ${verdict.reason}" +
            if (verdict.decision == ArchitectureDecision.NO_GO) "\n" + ArchitectureVerdict.ALTERNATIVES else ""
    }

    // ---- group identity (diagnosis only: never unlocks scanning)

    private fun recordStep(step: NavStep) {
        navTrace.addLast(step)
        while (navTrace.size > 15) navTrace.removeFirst()
    }

    private fun diagnoseGroup() {
        val current = channel ?: run { output.text = "Najpierw otwórz sesję."; return }
        lifecycleScope.launch {
            val started = Instant.now().toString()
            val probe = current.groupProbe()
            val segment = probe?.first ?: PocPolicy.groupSegment(url)
            val hits = probe?.second.orEmpty()
            val assessment = GroupIdentity.assess(PocPolicy.APPROVED_GROUP_ID, segment, hits, navTrace.toList())
            output.text = buildString {
                appendLine(GroupIdentity.describe(assessment))
                if (probe == null) appendLine("(strona nie odpowiedziała — rozszerzenie niepołączone)")
                appendLine()
                appendLine("ID z metadanych/JSON strony: " + if (hits.isEmpty()) "brak" else hits.joinToString { "${it.id} [${it.source}]" })
                appendLine("Łańcuch nawigacji (najnowsze na dole):")
                navTrace.forEach { step ->
                    val kind = when { step.isRedirect -> "przekierowanie"; step.viaHistory -> "zmiana adresu w stronie"; else -> "ładowanie" }
                    appendLine("• ${step.url}  [$kind${if (step.hasUserGesture) ", kliknięcie" else ""}]")
                }
            }
            runCatching {
                store.append(StoredRun("GROUP_DIAGNOSIS", started, Instant.now().toString(), assessment.verdict.name, emptyList(), emptyList(), 0, mapOf(
                    "segment" to (segment ?: "?"),
                    "strongIds" to assessment.strongIds.joinToString(),
                    "allIds" to hits.joinToString { "${it.id}:${it.source}" },
                    "facebookRedirect" to assessment.serverRedirect.toString(),
                    "trace" to navTrace.joinToString(" > ") { (if (it.isRedirect) "R:" else if (it.viaHistory) "H:" else "L:") + (if (it.hasUserGesture) "click:" else "") + it.url },
                )))
            }
        }
    }

    // ---- stage C: local screen-off test

    private fun startScreenOffTest() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            return
        }
        scheduleScreenOffTest()
    }

    private fun scheduleScreenOffTest() {
        val alarms = getSystemService(AlarmManager::class.java)
        if (Build.VERSION.SDK_INT >= 31 && !alarms.canScheduleExactAlarms()) {
            AlertDialog.Builder(this)
                .setTitle("Dokładny alarm")
                .setMessage("Bez zgody „Alarmy i przypomnienia” Android może opóźnić test i odmówić startu usługi z tła (to też zostanie zapisane jako wynik). Otworzyć ustawienia?")
                .setPositiveButton("Ustawienia") { _, _ ->
                    startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:$packageName")))
                }
                .setNegativeButton("Mimo to (niedokładny)") { _, _ -> confirmScheduled(ScreenOffTest.schedule(this, TEST_DELAY_MS)) }
                .show()
            return
        }
        confirmScheduled(ScreenOffTest.schedule(this, TEST_DELAY_MS))
    }

    private fun confirmScheduled(scheduled: ScreenOffTest.Scheduled) {
        output.text = "Test zaplanowany za ${TEST_DELAY_MS / 60_000} min (${if (scheduled.exact) "alarm dokładny" else "alarm niedokładny"}).\n" +
            "Podłącz ładowarkę, wygaś ekran i nie odblokowuj telefonu. Wynik pojawi się w powiadomieniu i w „Wyniki”.\n" +
            "Test otwiera tylko lokalną stronę testową — nie Facebooka."
    }

    private fun runScreenOffTestNow() {
        startForegroundService(Intent(this, ScreenOffTestService::class.java).putExtra(ScreenOffTestService.EXTRA_TRIGGER, "manual"))
        output.text = "Test lokalnego HTML uruchomiony teraz (porównanie z ekranem włączonym). Wynik w powiadomieniu i w „Wyniki”."
    }

    // ---- GeckoView delegates

    private val progressDelegate = object : GeckoSession.ProgressDelegate {
        override fun onPageStart(session: GeckoSession, url: String) {
            onUrl(url)
            lastLoadError = null
        }

        override fun onPageStop(session: GeckoSession, success: Boolean) {
            if (!success && responseBusy) stopVisiblePosts()
            render()
            val current = channel ?: return
            lifecycleScope.launch { current.probe()?.let { probe = it; render() } }
        }

        override fun onProgressChange(session: GeckoSession, progress: Int) {
            this@PocActivity.progress = progress
            render()
        }
    }

    private val contentDelegate = object : GeckoSession.ContentDelegate {
        override fun onTitleChange(session: GeckoSession, title: String?) {
            this@PocActivity.title = title?.take(120)
            render()
        }

        override fun onCrash(session: GeckoSession) = lostEngine("Proces strony uległ awarii")
        override fun onKill(session: GeckoSession) = lostEngine("System zamknął proces strony")
    }

    private val navigationDelegate = object : GeckoSession.NavigationDelegate {
        override fun onLocationChange(session: GeckoSession, url: String?, perms: MutableList<GeckoSession.PermissionDelegate.ContentPermission>, hasUserGesture: Boolean) {
            recordStep(NavStep(PocPolicy.sanitize(url), isRedirect = false, hasUserGesture = hasUserGesture, viaHistory = true))
            onUrl(url)
        }

        override fun onLoadRequest(session: GeckoSession, request: GeckoSession.NavigationDelegate.LoadRequest): GeckoResult<AllowOrDeny> {
            if (responseBusy && !responseReloadGate.allowRequest(request.uri, request.isRedirect, request.target == GeckoSession.NavigationDelegate.TARGET_WINDOW_NEW)) stopVisiblePosts()
            recordStep(NavStep(PocPolicy.sanitize(request.uri), request.isRedirect, request.hasUserGesture))
            if (!PocPolicy.allowNavigation(request.uri)) {
                blockedNavigations++
                lastBlockedHost = runCatching { Uri.parse(request.uri).host }.getOrNull()
                render()
                return GeckoResult.fromValue(AllowOrDeny.DENY)
            }
            if (request.target == GeckoSession.NavigationDelegate.TARGET_WINDOW_NEW) {
                // No pop-up windows: an allowed link opens in this session.
                session.loadUri(request.uri)
                return GeckoResult.fromValue(AllowOrDeny.DENY)
            }
            return GeckoResult.fromValue(AllowOrDeny.ALLOW)
        }

        override fun onLoadError(session: GeckoSession, uri: String?, error: WebRequestError): GeckoResult<String>? {
            if (responseBusy) stopVisiblePosts()
            lastLoadError = "kategoria ${error.category}, kod ${error.code} (${PocPolicy.sanitize(uri)})"
            render()
            return null
        }
    }

    private fun onUrl(value: String?) {
        if (!responseReloadGate.allowLocation(value)) stopVisiblePosts()
        url = value
        kind = PocPolicy.classify(value)
        if (kind == PageKind.APPROVED_GROUP) loginRequested = false
        render()
    }

    private fun lostEngine(reason: String) {
        haltMessage = "STOP: $reason. Sesja zamknięta; otwórz ją ponownie."
        closeSession()
    }

    // ---- UI

    private fun render() {
        if (!::banner.isInitialized) return
        val open = session != null
        val stop = haltMessage ?: if (open) PocPolicy.stopMessage(kind, loginRequested) else null
        banner.text = when {
            stop != null -> stop
            !open -> "Sesja zamknięta. „Otwórz sesję” uruchamia przeglądarkę tylko dla grupy ${PocPolicy.APPROVED_GROUP_ID}."
            loginRequested && kind == PageKind.LOGIN -> "Logowanie ręczne na stronie Facebooka. Po zalogowaniu użyj „Wróć do grupy”."
            responseBusy -> if (responseReloadGate.active) "Trwa diagnostyka od otwarcia (25 s)." else "Trwa lokalna diagnostyka odpowiedzi (15 s)."
            scanning -> "Trwa skan (max ${PocPolicy.MAX_POSTS} postów, ${PocPolicy.SCAN_TIMEOUT_MS / 1000} s)…"
            kind == PageKind.APPROVED_GROUP && preferences.getBoolean(KEY_ONE_SCAN_USED, false) ->
                "Zatwierdzona grupa otwarta. Limit jednego skanu testowego wykorzystany; wyniki dostępne lokalnie."
            kind == PageKind.APPROVED_GROUP -> "Zatwierdzona grupa otwarta. Możesz uruchomić jeden skan."
            else -> "Sesja otwarta (${kind.name})."
        }
        banner.setBackgroundColor(if (stop != null) Color.parseColor("#B3261E") else Color.parseColor("#1E5AA8"))

        val canScan = open && !responseBusy && !scanning && stop == null && !preferences.getBoolean(KEY_ONE_SCAN_USED, false) && PocPolicy.canScan(kind) && channel?.isConnected == true
        buttons["open"]?.text = if (open) "Zamknij sesję" else "Otwórz sesję"
        listOf("group", "login", "back").forEach { buttons[it]?.isEnabled = open && !scanning }
        listOf("scan", "scan3").forEach { buttons[it]?.isEnabled = canScan }
        buttons["responses"]?.isEnabled = open && !responseBusy && !visibleBusy && !scanning && !inspectingDom && kind == PageKind.APPROVED_GROUP && progress == 100 && channel?.isConnected == true
        buttons["responseLoad"]?.isEnabled = buttons["responses"]?.isEnabled == true
        buttons["responseLoadScroll"]?.isEnabled = buttons["responses"]?.isEnabled == true
        buttons["responseScroll"]?.isEnabled = buttons["responses"]?.isEnabled == true
        buttons["dom"]?.isEnabled = open && !responseBusy && !scanning && !inspectingDom &&
            kind == PageKind.APPROVED_GROUP && channel?.isConnected == true

        val p = probe
        diagnostics.text = buildString {
            appendLine("PRÓBA SKANU: " + scanAttemptSummary())
            appendLine()
            appendLine("Silnik: GeckoView ${org.mozilla.geckoview.BuildConfig.MOZ_APP_VERSION} • rozszerzenie: ${if (extension != null) "zainstalowane" else extensionError ?: "instalacja…"}")
            appendLine("User-Agent: ${userAgent ?: "—"}")
            appendLine("UA zawiera „; wv”: ${userAgent?.contains("; wv") ?: "—"} • nadpisany: nie")
            appendLine("Adres: ${PocPolicy.sanitize(url)} • typ: $kind • ładowanie: $progress%")
            appendLine("Tytuł: ${title ?: "—"}")
            appendLine("Port rozszerzenia: ${if (channel?.isConnected == true) "połączony" else "brak"} • odrzucone porty: ${channel?.untrustedPorts ?: 0}")
            if (p != null) appendLine("DOM (${p.host}${p.path}): elementy ${p.elements}, formularze ${p.forms}, pola ${p.inputs}, hasła ${p.passwordInputs}, posty ${p.articles}, iframe ${p.iframes}, stan ${p.readyState}")
            appendLine("Błąd ładowania: ${lastLoadError ?: "brak"}")
            append("Zablokowane przejścia: $blockedNavigations${lastBlockedHost?.let { " (ostatnie: $it)" } ?: ""}")
        }
    }

    private fun buildLayout(): View {
        val dp = resources.displayMetrics.density
        fun button(key: String, label: String, onClick: () -> Unit) = Button(this).apply {
            text = label
            isAllCaps = false
            textSize = 13f
            setOnClickListener { onClick() }
            buttons[key] = this
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        fun row(vararg views: View) = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            views.forEach(::addView)
        }
        banner = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 14f
            setPadding((12 * dp).toInt(), (8 * dp).toInt(), (12 * dp).toInt(), (8 * dp).toInt())
        }
        geckoView = GeckoView(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        }
        diagnostics = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 10.5f
            setTextColor(Color.parseColor("#1B1B1F"))
            setTextIsSelectable(true)
        }
        output = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 10.5f
            setTextColor(Color.parseColor("#1B1B1F"))
            setTextIsSelectable(true)
        }
        val info = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (190 * dp).toInt())
            setPadding((8 * dp).toInt(), (4 * dp).toInt(), (8 * dp).toInt(), (4 * dp).toInt())
            addView(LinearLayout(this@PocActivity).apply {
                orientation = LinearLayout.VERTICAL
                addView(diagnostics)
                addView(output)
            })
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#FAFAFC"))
            addView(banner)
            addView(row(
                button("open", "Otwórz sesję") { if (session == null) askConsentAndOpen() else closeSession() },
                button("group", "Otwórz grupę") { load(PocPolicy.APPROVED_GROUP_URL, login = false) },
                button("login", "Zaloguj się") { load(PocPolicy.LOGIN_URL, login = true) },
                button("back", "Wróć do grupy") { load(PocPolicy.APPROVED_GROUP_URL, login = false) },
            ))
            addView(geckoView)
            addView(row(
                button("scan", "Skanuj widoczne") { scan(scrolls = 0) },
                button("scan3", "Skanuj + przewiń 3×") { scan(scrolls = 3) },
            ))
            addView(row(button("responses", "Sprawdź dane sieciowe") { checkResponses() }, button("responseScroll", "Dane + przewijanie") { checkResponses(autoScroll = true) }))
            addView(row(button("responseLoad", "Odpowiedzi od otwarcia") { checkResponseLoad() }, button("responseLoadScroll", "Otwarcie + przewijanie") { checkResponseLoad(autoScroll = true) }))
            addView(row(button("visiblePosts", "Sprawdź widoczne posty") { checkVisiblePosts() }))
            addView(row(
                button("dom", "Diagnoza postów") { inspectDom() },
                button("diagnose", "Diagnoza grupy") { diagnoseGroup() },
                button("results", "Wyniki") { showResults() },
            ))
            addView(row(
                button("netControl", "Test sieci GeckoView") { runNetworkControl() },
                button("loadMeasure", "Zmierz otwarcie grupy") { measureGroupOpening() },
            ))
            addView(row(
                button("test10", "Test ekranu za 10 min") { startScreenOffTest() },
                button("testNow", "Test teraz") { runScreenOffTestNow() },
                button("clear", "Wyloguj i usuń dane") { clearSessionData() },
            ))
            addView(info)
        }
        // Edge-to-edge (targetSdk 35+): keep the UI clear of the status/navigation bars and the keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        return root
    }

    companion object {
        private const val KEY_CONSENT = "facebook_session_consent"
        private const val KEY_ONE_SCAN_USED = "manual_slug_scan_one_shot_20261017"
        private const val KEY_ATTEMPT_STAGE = "one_shot_attempt_stage"
        private const val KEY_ATTEMPT_AT = "one_shot_attempt_started_at"
        private const val KEY_ATTEMPT_STATUS = "one_shot_attempt_status"
        private const val KEY_ATTEMPT_POSTS = "one_shot_attempt_post_count"
        private const val KEY_ATTEMPT_REJECTED = "one_shot_attempt_rejected_count"
        private const val KEY_ATTEMPT_ERROR = "one_shot_attempt_error_class"
        private const val KEY_ATTEMPT_SAVE_ERROR = "one_shot_attempt_store_error"
        private const val TEST_DELAY_MS = 10 * 60 * 1000L
    }
}
