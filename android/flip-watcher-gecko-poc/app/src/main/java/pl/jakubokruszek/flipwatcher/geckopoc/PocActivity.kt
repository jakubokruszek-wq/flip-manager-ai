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
import android.widget.FrameLayout
import android.widget.EditText
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import android.text.InputType
import android.view.inputmethod.EditorInfo
import android.widget.CheckBox
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
    private lateinit var offersPanel:OffersPanel
    private lateinit var facebookTab:Button
    private lateinit var offersTab:Button
    private lateinit var banner: TextView
    private lateinit var diagnostics: TextView
    private lateinit var output: TextView
    internal var diagnosticsDialog: AlertDialog? = null; private set
    private lateinit var fastScrollOption: CheckBox
    private val buttons = mutableMapOf<String, Button>()

    private var session: GeckoSession? = null
    private var channel: CollectorChannel? = null
    private var extension: WebExtension? = null
    private var extensionError: String? = null

    private var url: String? = null
    private var kind = PageKind.BLANK
    private var pageLoaded = false
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
    internal val desktopThumbnails=DesktopThumbnails()
    private var reviewClosing=false
    private fun reviewWorking()=reviewBusy||reviewClosing
    private var reviewBusy=false
    private var reviewJob:Job?=null
    private var reviewConsentDialog:AlertDialog?=null
    private var reviewPosition=0
    private var reviewTotal=0
    private var reviewLast:ReviewDataSummary?=null
    private var reviewSnapshot:ReviewDataSummary?=null
    private var reviewReportPending=false
    private val reviewPrefs get()=getSharedPreferences(groupPreference("review_data_counts_v1"),MODE_PRIVATE)
    private var desktopBusy=false
    private var desktopGate:DesktopTrial?=null
    private var desktopNonce:String?=null
    private var desktopJob:Job?=null
    private var desktopConsentDialog:android.app.Dialog?=null
    internal var desktopResultDialog:AlertDialog?=null; private set
    private var ocrBusy=false
    private var ocrEpoch=0L
    private var ocrJob:Job?=null
    private var ocrConsentDialog:AlertDialog?=null
    private var ocrLast:OcrSummary?=null
    private var ocrReportPending=false
    private var reviewOcrActive=false
    private val ocrResults=linkedMapOf<String,DesktopRow>()
    private val ocrPrefs get()=getSharedPreferences(groupPreference("ocr_counts_v1"),MODE_PRIVATE)
    private var desktopRows:List<DesktopRow> = emptyList()
    private var savedResult:SavedResult?=null
    private val savedThumbnails=DesktopThumbnails()
    private var archiveRevision=0L
    private var archiveWritePending=false
    private var archiveError:String?=null
    private var watcherBusy=false
    private var watcherMessage:String?=null
    private var watcherDialog:AlertDialog?=null
    private var watcherResultDialog:AlertDialog?=null
    private fun showPendingWatcherResult(){
        if(!lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)||isFinishing||isDestroyed)return
        val message=watcherMessage?:return;watcherMessage=null
        watcherResultDialog?.dismiss()
        watcherResultDialog=AlertDialog.Builder(this).setTitle("Połączenie z Watcherem").setMessage(message).setPositiveButton("OK",null).create().also{it.show()}
    }
    private var deletingResults=false
    internal var deleteResultsDialog:AlertDialog?=null; private set
    private fun displayedRows()=desktopRows.ifEmpty{savedResult?.rows.orEmpty()}
    private fun savedNotice()=savedResult?.let{"Zachowany wynik: "+java.text.DateFormat.getDateTimeInstance().format(java.util.Date(it.savedAt))+". Dane historyczne; nowy odczyt wymaga nowej zgody."}
    private fun showSavedResult(){
        if(!::offersPanel.isInitialized||desktopRows.isNotEmpty())return
        offersPanel.showRows(savedResult?.rows.orEmpty(),archiveError?:savedNotice(),thumbnails={savedThumbnails.rows(it)},archived=true,postTexts=savedResult?.postTexts.orEmpty())
    }
    private fun readSavedResult(){
        val revision=archiveRevision
        ResultArchiveJobs.load(this){result->
            if(isDestroyed||revision!=archiveRevision)return@load
            result.onSuccess{value->
                archiveWritePending=false;savedResult=value;savedThumbnails.clear();archiveError=null
                value?.photos?.filter{!it.crop}?.forEach{p->
                    android.graphics.BitmapFactory.decodeByteArray(p.jpeg,0,p.jpeg.size)?.let{savedThumbnails.put(p.postId,p.slot,it)}
                }
            }.onFailure{archiveError="Nie udało się odczytać zapisanej bazy. Plik pozostaje zachowany; nie zastępujemy go pustym wynikiem."}
            if(::offersPanel.isInitialized&&desktopRows.isNotEmpty())offersPanel.showRows(desktopRows,thumbnails=::offerPictures)else showSavedResult()
            render()
            if(desktopRows.isEmpty()&&session==null&&savedResult?.rows?.isNotEmpty()==true&&!busyForTabs())selectContentTab(true)
        }
    }
    private fun saveResult(rows:List<DesktopRow> = desktopRows,ocr:List<DesktopRow> = ocrResults.values.toList(),photos:Boolean=false,extraImages:DesktopThumbnails?=null){
        if(deletingResults||rows.isEmpty())return
        archiveWritePending=true
        val revision=++archiveRevision
        ResultArchiveJobs.save(this,rows.toList(),ocr.toList(),if(photos)desktopThumbnails else extraImages,replacePhotos=false){success->
            if(isDestroyed||revision!=archiveRevision)return@save
            if(success)readSavedResult() else {
                archiveWritePending=false
                archiveError="Nie zapisano nowego wyniku. Poprzednia zapisana baza pozostaje zachowana."
                if(::output.isInitialized)output.text=archiveError
            }
        }
    }
    internal fun askDeleteResults(){
        if(busyForTabs()||deletingResults)return
        deleteResultsDialog?.dismiss()
        deleteResultsDialog=AlertDialog.Builder(this).setTitle("Kasuj bazę")
            .setMessage("Usunąć zachowany wynik wyszukiwania, zdjęcia i sugestie OCR wybranej grupy? Nie wyloguje to z Facebooka. Historia wysłanych danych i limity skanu pozostają bez zmian.")
            .setNegativeButton("Anuluj",null).setPositiveButton("Kasuj bazę"){_,_->
                deletingResults=true;archiveRevision++;clearDesktopDetails();render()
                ResultArchiveJobs.delete(this){success->
                    if(isDestroyed)return@delete
                    deletingResults=false
                    if(success){photoPrefs.edit().clear().commit();photoLast=null;photoReportPending=false;photoDiagnosisPrefs.edit().clear().commit();savedResult=null;savedThumbnails.clear();ocrResults.clear();archiveError="Baza wyników została usunięta."}
                    else archiveError="Nie udało się usunąć bazy. Spróbuj ponownie."
                    showSavedResult();render()
                }
            }.create().also{it.show()}
    }
    private var desktopResultText:TextView?=null
    private val desktopPrefs get()=getSharedPreferences(groupPreference("desktop_trial_summary_v1"),MODE_PRIVATE)
    private var shareResolver: ShareLinkResolver? = null
    internal var lastShareResultDialog: AlertDialog? = null; private set
    private val shareResults by lazy { ShareLinkResultStore(this) }
    private var shareBusy = false
    private var sharePortAfterGeneration = 0L
    private var shareDocumentAfter = 0L
    private var sharePageLoading = false
    private var shareJob: Job? = null
    private var shareDialog: AlertDialog? = null
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
        WatcherAutomation.uiVisible=true
        if(android.os.Build.VERSION.SDK_INT>=33)setRecentsScreenshotEnabled(false)
        preferences.getString("watcher_active_groups",null)?.let{raw->runCatching{WatcherGroups.setActive(WatcherLink.parseGroups(raw))}}
        val selected=preferences.getString("selected_watcher_group",WatcherGroups.LEGACY_GROUP)
            ?.takeIf{WatcherGroups.isActive(it)}?:WatcherGroups.active.firstOrNull()?.id
        if(selected!=null)PocPolicy.selectGroup(selected)
        setContentView(buildLayout())
        readSavedResult()
        if(WatcherAutomation.enabled(this))runCatching{WatcherAutomation.configure(this,true)}
        lifecycleScope.launch {
            extension = runCatching { GeckoHost.collectorExtension(this@PocActivity) }
                .onFailure { extensionError = it.javaClass.simpleName + ": " + (it.message ?: "").take(80) }
                .getOrNull()
            render()
        }
        render()
    }

    override fun onDestroy() {
        diagnosticsDialog?.dismiss()
        watcherDialog?.dismiss();watcherResultDialog?.dismiss()
        deleteResultsDialog?.dismiss();savedThumbnails.clear()
        lastShareResultDialog?.dismiss()
        closeSession()
        super.onDestroy()
    }

    private lateinit var automationSummary:TextView
    private var automationLiveJob:Job?=null
    private fun monitorAutomation(){
        automationLiveJob?.cancel()
        automationLiveJob=lifecycleScope.launch{
            while(true){
                val text=kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO){
                    runCatching{
                        val state=WatcherScanStatus.read(this@PocActivity)
                        val enabled=WatcherAutomation.enabled(this@PocActivity)
                        val next=AutomationPolicy.next(java.time.Instant.now(),java.time.ZoneId.systemDefault(),WatcherAutomation.schedule(this@PocActivity)).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("dd.MM HH:mm"))
                        val window=AutomationPolicy.current(java.time.Instant.now(),java.time.ZoneId.systemDefault(),WatcherAutomation.schedule(this@PocActivity))
                        val prefs=WatcherAutomation.preferences(this@PocActivity)
                        val pending=enabled&&!state.active&&state.started<window.at.toEpochMilli()&&window.at.toEpochMilli()>=prefs.getLong("schedule_since",0)&&prefs.getString("completed_slot",null)!=window.key
                        (if(!enabled)"Automat wyłączony"
                        else if(state.total>0)"Automat ${state.done}/${state.total}: "+ScanStatusText.title(state,true,System.currentTimeMillis(),null)
                        else if(pending)"Automat: skan oczekuje"
                        else "Automat: "+ScanStatusText.title(state,true,System.currentTimeMillis(),null))+" • Podgląd"
                    }.getOrDefault("Automat: nie udało się odczytać stanu • Podgląd")
                }
                automationSummary.text=text
                delay(2_000)
            }
        }
    }
    override fun onResume(){super.onResume();monitorAutomation();WatcherAutomation.uiVisible=true;if(!reviewWorking())runCatching{session?.setActive(true)};window.decorView.post{showSavedResult();showPendingPhotosReport();showPendingReviewReport();showPendingOcrReport();showPendingWatcherResult()}}

    override fun onPause() {
        automationLiveJob?.cancel();automationLiveJob=null
        automationStatusDialog?.dismiss();automationScheduleDialog?.dismiss();automationTimeDialog?.dismiss()
        ocrConsentDialog?.dismiss();ocrConsentDialog=null;cancelOcr("PAUSED")
        reviewConsentDialog?.dismiss();reviewConsentDialog=null;cancelReview("PAUSED")
        desktopConsentDialog?.dismiss();desktopConsentDialog=null
        finishDesktop("PAUSED",show=false);clearDesktopDetails()
        shareDialog?.dismiss(); shareDialog = null
        lastShareResultDialog?.dismiss(); lastShareResultDialog = null
        finishShare("PAUSED", clear = true)
        stopVisiblePosts()
        WatcherAutomation.uiVisible=false
        super.onPause()
        runCatching{WatcherAutomation.onBackground(applicationContext)}
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

    private fun finishShare(reason: String? = null, clear: Boolean = false) {
        val resolver = shareResolver ?: return
        val wasBusy = shareBusy
        if (reason != null && resolver.active) resolver.stop(reason)
        shareJob?.cancel(); shareJob = null
        channel?.stopShareLinkContext()
        shareBusy = false
        if (wasBusy && resolver.status != ShareLinkResolver.Status.CONFIRMED) session?.stop()
        if (::output.isInitialized) output.text = if (clear) "" else resolver.report()
        if (wasBusy) ShareLinkResult.snapshot(resolver)?.let { publishShareResult(it, showImmediately = !clear) }
        if (clear) shareResolver = null
        if (::banner.isInitialized) render()
    }

    internal fun publishShareResult(result: ShareLinkResult, showImmediately: Boolean) {
        val saved = shareResults.save(result)
        if (::output.isInitialized) output.text = result.report() + if (saved) "" else "\nUWAGA: wynik nie został zapisany; skopiuj raport teraz."
        if (showImmediately && lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) showLastShareResult(result, saved)
    }

    internal fun showLastShareResult(result: ShareLinkResult? = shareResults.read(), saved: Boolean = true) {
        lastShareResultDialog?.dismiss()
        val text = result?.report()?.let { it + if (saved) "" else "\nUWAGA: zapis nie powiódł się." }
            ?: "Brak zapisanego wyniku sprawdzania linku. Samo ręczne otwarcie posta nie uruchamia tej funkcji. Wyników z wersji 0.4.0 nie można odtworzyć."
        lastShareResultDialog = AlertDialog.Builder(this).setTitle("Ostatni wynik linku")
            .setMessage(text).setPositiveButton("Zamknij", null)
            .setNeutralButton("Kopiuj raport") { _, _ ->
                getSystemService(android.content.ClipboardManager::class.java).setPrimaryClip(android.content.ClipData.newPlainText("Raport linku", text))
            }.create()
        lastShareResultDialog?.show()
    }

    private var desktopFollowUp:(()->Unit)?=null
    private fun startDesktopPreview(){
        if(ocrBusy||reviewWorking()||desktopBusy||shareBusy||responseBusy||visibleBusy||scanning||inspectingDom||measuringLoad||kind!=PageKind.APPROVED_GROUP||progress!=100||channel?.isConnected!=true)return
        val currentSession=session?:return;val currentChannel=channel?:return;val target=url?:return
        desktopConsentDialog=DesktopConsentDialog(this,onAccept=accept@{automaticPhotos->
                if(reviewWorking()||!lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.R…18638 tokens truncated…wymaga otwartego ekranu aplikacji. Android może opóźnić start; po wymuszonym zatrzymaniu trzeba ponownie otworzyć aplikację.\n\nOferty i przypisane miniatury trafiają do sparowanego Managera. Automat odczytuje też tekst ze zdjęć lokalnym OCR i uzupełnia brakujące dane; nie nadpisuje sprzecznych danych tekstowych. Kolejka ponawia wysyłkę bez duplikatów. Logowanie i baza pozostają na telefonie. CAPTCHA wymaga ręcznej obsługi.\n\n"+status
                setTextIsSelectable(true)
            })
            automationStatusDialog?.dismiss();automationStatusDialog=dialog
            dialog.setOnDismissListener{if(automationStatusDialog===dialog)automationStatusDialog=null}
            dialog.show()
    }

    private fun watcherConnection(){
        if(busyForTabs()||archiveWritePending)return
        val input=android.widget.EditText(this).apply{
            tag="watcher.pairing.code"
            hint="Kod parowania z Managera (JSON)";maxLines=6
            inputType=android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            importantForAutofill=android.view.View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
            filters=arrayOf(android.text.InputFilter.LengthFilter(4096))
        }
        val dialog=AlertDialog.Builder(this).setTitle("Połącz z Watcherem")
            .setMessage("W Managerze otwórz Połącz Flip Collector i wybierz Kod dla aplikacji Android. Wklej kod poniżej. Połączenie synchronizuje aktywne grupy. Osobny przycisk automatu włącza wysyłkę ofert i zdjęć.")
            .setView(input).setNegativeButton("Wróć",null)
            .setNeutralButton("Synchronizuj grupy"){_,_->synchronizeWatcher(null)}
            .setPositiveButton("Połącz"){_,_->val raw=input.text.toString();input.text.clear();synchronizeWatcher(raw)}.create()
        watcherDialog=dialog
        dialog.setOnDismissListener{input.text.clear();if(watcherDialog===dialog)watcherDialog=null}
        dialog.window?.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
        dialog.show();dialog.window?.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
    }
    private fun synchronizeWatcher(pairing:String?){
        if(busyForTabs()||archiveWritePending)return
        closeSession();watcherBusy=true;render()
        lifecycleScope.launch{
            try{
                val groups=kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO){
                    val credentials=if(pairing==null)WatcherLink.load(this@PocActivity)?:error("WATCHER_PAIRING_REQUIRED") else WatcherLink.parsePairing(pairing)
                    val value=WatcherLink.groups(credentials,verifyDevice=pairing!=null)
                    if(pairing!=null)WatcherLink.save(this@PocActivity,credentials)
                    value
                }
                val cache=org.json.JSONObject().put("version",1).put("groups",org.json.JSONArray(groups.map{org.json.JSONObject().put("groupId",it.id).put("url",it.url).put("name",it.name)})).toString()
                check(preferences.edit().putString("watcher_active_groups",cache).commit())
                archiveRevision++;savedResult=null;savedThumbnails.clear();ocrResults.clear();archiveError=null
                WatcherGroups.setActive(groups)
                WatcherAutomation.preferences(this@PocActivity).edit().remove("completed_slot").apply()
                val selected=PocPolicy.APPROVED_GROUP_ID.takeIf{WatcherGroups.isActive(it)}?:groups.firstOrNull()?.id
                if(selected!=null){PocPolicy.selectGroup(selected);preferences.edit().putString("selected_watcher_group",selected).apply()}
                photoLast=null;ocrLast=null;reviewLast=null;reviewSnapshot=null
                photoReportPending=false;ocrReportPending=false;reviewReportPending=false
                showSavedResult();readSavedResult()
                watcherMessage="Połączono z Watcherem. Aktywne grupy: ${groups.size}. Zapisane oferty i zdjęcia pozostały na telefonie."
                output.text=watcherMessage
            }catch(e:kotlinx.coroutines.CancellationException){throw e}
            catch(_:Exception){watcherMessage="Nie zsynchronizowano grup. Sprawdź połączenie i kod parowania. Zachowana baza oraz poprzednia lista grup pozostają bez zmian.";output.text=watcherMessage}
            finally{watcherBusy=false;render();showPendingWatcherResult()}
        }
    }

    private fun groupPreference(base:String)=if(PocPolicy.APPROVED_GROUP_ID==WatcherGroups.LEGACY_GROUP)base else base+"_"+PocPolicy.APPROVED_GROUP_ID

    private fun chooseWatcherGroup(){
        if(busyForTabs()||deletingResults||archiveWritePending)return
        val groups=WatcherGroups.active
        if(groups.isEmpty()){AlertDialog.Builder(this).setMessage("Watcher nie ma aktywnych grup. Włącz grupy w Managerze i zsynchronizuj ponownie.").setPositiveButton("OK",null).show();return}
        val selected=groups.indexOfFirst{it.id==PocPolicy.APPROVED_GROUP_ID}
        AlertDialog.Builder(this).setTitle("Grupy z Watchera")
            .setSingleChoiceItems(groups.map{it.name}.toTypedArray(),selected){dialog,index->
                val group=groups[index]
                if(busyForTabs()||deletingResults||archiveWritePending){dialog.dismiss();return@setSingleChoiceItems}
                if(group.id!=PocPolicy.APPROVED_GROUP_ID){
                    // Close/cancel while the old policy is still active; old disk jobs already own their group.
                    closeSession();archiveRevision++;savedResult=null;savedThumbnails.clear();archiveError=null
                    ocrResults.clear();photoLast=null;photoReportPending=false;ocrLast=null;ocrReportPending=false
                    reviewSnapshot=null;reviewLast=null;reviewReportPending=false
                    PocPolicy.selectGroup(group.id)
                    preferences.edit().putString("selected_watcher_group",group.id).apply()
                    navTrace.clear();haltMessage=null
                    showSavedResult();readSavedResult();render()
                }
                dialog.dismiss();diagnosticsDialog?.dismiss()
            }.setNegativeButton("Wróć",null).show()
    }

    private fun openSession() {
        if(WatcherAutomation.lock.isLocked){output.text="Automat kończy pracę w tle. Spróbuj za chwilę.";return}
        if (session != null) return
        val ext = extension ?: run { output.text = "Rozszerzenie kolektora nie jest gotowe: ${extensionError ?: "instalacja w toku"}"; return }
        // Default settings: normal mobile Firefox user agent, JavaScript and cookies as in the browser. No override, no spoofing.
        val newSession = GeckoSession(GeckoSessionSettings.Builder().build())
        val newChannel = CollectorChannel(newSession, fixtureMode = false, onVisibleStop = { stopVisiblePosts() }, onPageDisconnect = { if(!reviewWorking()&&!desktopBusy&&desktopRows.isNotEmpty())clearDesktopDetails(); if(desktopBusy&&desktopGate?.phase==DesktopTrial.Phase.READING)finishDesktop("PORT_LOST"); shareResolver?.disconnected(); if (!responseReloadGate.allowOldDisconnect()) stopVisiblePosts(); if (shareBusy && shareResolver?.active != true) finishShare() }, onPageConnected = { responseReloadGate.connected() }, onShareStop = { if (shareBusy) finishShare("UNSAFE_DOCUMENT") }, onDesktopStop={if(desktopBusy)finishDesktop("CONTEXT")}) { value -> probe = value; render() }
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
        reviewConsentDialog?.dismiss();reviewConsentDialog=null;cancelReview("SESSION_CLOSED")
        finishDesktop("CANCELLED",show=false);clearDesktopDetails()
        finishShare("SESSION_CLOSED", clear = true)
        stopVisiblePosts()
        channel?.close()
        channel = null
        session?.let { current ->
            runCatching{current.contentDelegate=null;current.navigationDelegate=null;current.progressDelegate=null}
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
        selectContentTab(false)
        finishShare("MANUAL_NAVIGATION", clear = true)
        shareResolver = null
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
        if (scanning || preferences.getBoolean(groupPreference(KEY_ONE_SCAN_USED), false)) return
        val started = Instant.now().toString()
        // Record one-shot consent AND the pending attempt in a single durable commit.
        // Never reset this permission merely because scanning failed.
        val permitted = preferences.edit()
            .putBoolean(groupPreference(KEY_ONE_SCAN_USED), true)
            .putString(groupPreference(KEY_ATTEMPT_STAGE), "STARTED")
            .putString(groupPreference(KEY_ATTEMPT_AT), started)
            .putString(groupPreference(KEY_ATTEMPT_STATUS), "PENDING")
            .putInt(groupPreference(KEY_ATTEMPT_POSTS), 0)
            .putInt(groupPreference(KEY_ATTEMPT_REJECTED), 0)
            .putString(groupPreference(KEY_ATTEMPT_ERROR), "")
            .putString(groupPreference(KEY_ATTEMPT_SAVE_ERROR), "")
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
            preferences.edit().putString(groupPreference(KEY_ATTEMPT_STAGE), "ABORTED")
                .putString(groupPreference(KEY_ATTEMPT_STATUS), "NO_REQUEST_SENT")
                .putString(groupPreference(KEY_ATTEMPT_ERROR), "START_WRITE_FAILED:$reason").commit()
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
                    .putString(groupPreference(KEY_ATTEMPT_STAGE), "FINISHED")
                    .putString(groupPreference(KEY_ATTEMPT_STATUS), report.status.name)
                    .putInt(groupPreference(KEY_ATTEMPT_POSTS), report.posts.size)
                    .putInt(groupPreference(KEY_ATTEMPT_REJECTED), report.rejectedByApp)
                    .putString(groupPreference(KEY_ATTEMPT_ERROR), if (report.error.isNullOrBlank()) "" else "SCAN_RESPONSE_ERROR")
                    .putString(groupPreference(KEY_ATTEMPT_SAVE_ERROR), if (saveError.isEmpty()) "" else "RESULT_WRITE_FAILED:$saveError")
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
                    .putString(groupPreference(KEY_ATTEMPT_STAGE), "ABORTED")
                    .putString(groupPreference(KEY_ATTEMPT_STATUS), result)
                    .putString(groupPreference(KEY_ATTEMPT_ERROR), reason)
                    .putString(groupPreference(KEY_ATTEMPT_SAVE_ERROR),
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
        consumed = preferences.getBoolean(groupPreference(KEY_ONE_SCAN_USED), false),
        stage = preferences.getString(groupPreference(KEY_ATTEMPT_STAGE), null),
        status = preferences.getString(groupPreference(KEY_ATTEMPT_STATUS), null),
        posts = preferences.getInt(groupPreference(KEY_ATTEMPT_POSTS), 0),
        rejected = preferences.getInt(groupPreference(KEY_ATTEMPT_REJECTED), 0),
        startedAt = preferences.getString(groupPreference(KEY_ATTEMPT_AT), null),
        error = preferences.getString(groupPreference(KEY_ATTEMPT_ERROR), null),
        saveError = preferences.getString(groupPreference(KEY_ATTEMPT_SAVE_ERROR), null),
    )

    private fun showResults() {
        val runs = store.runs()
        // Prioritize the real scan outcome above verbose older group diagnoses.
        val scans = runs.filter { it.kind.startsWith("GROUP_SCAN") }
        val other = runs.filterNot { it.kind.startsWith("GROUP_SCAN") }
        output.text = buildString {
            shareResults.read()?.let { appendLine(it.report()); appendLine() }
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
            pageLoaded=false;progress=0
            if (shareBusy) { sharePageLoading = true; progress = 0 }
            onUrl(url)
            lastLoadError = null
        }

        override fun onPageStop(session: GeckoSession, success: Boolean) {
            pageLoaded=success
            if(!success&&desktopBusy)finishDesktop("LOAD_ERROR")
            if (shareBusy) sharePageLoading = false
            if (!success && shareBusy) finishShare("LOAD_ERROR")
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
            if(session!==this@PocActivity.session)return
            if (shareBusy && Regex("log in|logowanie|captcha|checkpoint|security check|potwierdź.*tożsamość", RegexOption.IGNORE_CASE).containsMatchIn(title.orEmpty())) finishShare("VERIFICATION_OR_LOGIN")
            if(Regex("log in|logowanie|captcha|checkpoint|security check|potwierdź.*tożsamość",RegexOption.IGNORE_CASE).containsMatchIn(title.orEmpty())){if(desktopBusy)finishDesktop("CONTEXT") else if(desktopRows.isNotEmpty())clearDesktopDetails()}
            this@PocActivity.title = title?.take(120)
            render()
        }

        override fun onCrash(session: GeckoSession){if(session===this@PocActivity.session)lostEngine("Proces strony uległ awarii","ORIGINAL_ENGINE_CRASHED")}
        override fun onKill(session: GeckoSession){if(session===this@PocActivity.session)lostEngine("System zamknął proces strony","ORIGINAL_ENGINE_KILLED")}
    }

    private val navigationDelegate = object : GeckoSession.NavigationDelegate {
        override fun onLocationChange(session: GeckoSession, url: String?, perms: MutableList<GeckoSession.PermissionDelegate.ContentPermission>, hasUserGesture: Boolean) {
            if (shareResolver == null) recordStep(NavStep(PocPolicy.sanitize(url), isRedirect = false, hasUserGesture = hasUserGesture, viaHistory = true))
            onUrl(url, hasUserGesture)
        }

        override fun onLoadRequest(session: GeckoSession, request: GeckoSession.NavigationDelegate.LoadRequest): GeckoResult<AllowOrDeny> {
            if(desktopBusy&&desktopGate?.request(request.uri,request.isRedirect,request.target==GeckoSession.NavigationDelegate.TARGET_WINDOW_NEW,request.hasUserGesture)!=true){finishDesktop("NAVIGATION");return GeckoResult.fromValue(AllowOrDeny.DENY)}
            val resolver = shareResolver
            if (shareBusy && resolver != null && !resolver.request(request.uri, request.isRedirect, request.target == GeckoSession.NavigationDelegate.TARGET_WINDOW_NEW, request.hasUserGesture)) {
                finishShare(); return GeckoResult.fromValue(AllowOrDeny.DENY)
            }
            if (!shareBusy && resolver != null && request.isRedirect) return GeckoResult.fromValue(AllowOrDeny.DENY)
            if (!shareBusy && resolver != null && !request.isRedirect) shareResolver = null
            if (responseBusy && !responseReloadGate.allowRequest(request.uri, request.isRedirect, request.target == GeckoSession.NavigationDelegate.TARGET_WINDOW_NEW)) stopVisiblePosts()
            if (shareResolver == null) recordStep(NavStep(PocPolicy.sanitize(request.uri), request.isRedirect, request.hasUserGesture))
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
            if(desktopBusy)finishDesktop("LOAD_ERROR")
            if (shareBusy) finishShare("LOAD_ERROR")
            if (responseBusy) stopVisiblePosts()
            lastLoadError = "kategoria ${error.category}, kod ${error.code} (${PocPolicy.sanitize(uri)})"
            render()
            return null
        }
    }

    private fun onUrl(value: String?, hasUserGesture: Boolean = false) {
        if(desktopBusy&&(hasUserGesture||desktopGate?.location(value)!=true))finishDesktop("NAVIGATION")
        if(!reviewWorking()&&!desktopBusy&&value!=url)clearDesktopDetails()
        if (!shareBusy && shareResolver != null && value != url) shareResolver = null
        val shareFailed = shareBusy && shareResolver?.location(value, hasUserGesture) != true
        if (!responseReloadGate.allowLocation(value)) stopVisiblePosts()
        url = value
        kind = PocPolicy.classify(value)
        if (shareFailed) finishShare()
        val resolver = shareResolver
        val reload = if (shareBusy) resolver?.pendingAddressReload else null
        if (reload != null) {
            val expectedSession = session
            val expectedChannel = channel
            // Run after the delegate returns. Recheck every identity and lifecycle guard.
            lifecycleScope.launch {
                kotlinx.coroutines.yield()
                // Do not cancel the first page mid-load: its onPageStop(false) is a real STOP.
                while (shareBusy && shareResolver === resolver && resolver != null && resolver.active && sharePageLoading) delay(50)
                if (shareBusy && shareResolver === resolver && session === expectedSession &&
                    channel === expectedChannel && url == reload && expectedSession != null && expectedChannel != null &&
                    lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED) && resolver != null && resolver.claimAddressReload(reload)) {
                    expectedChannel.stopShareLinkContext()
                    sharePortAfterGeneration = expectedChannel.connectionGeneration
                    shareDocumentAfter = System.currentTimeMillis()
                    progress = 0
                    expectedSession.loadUri(reload)
                }
            }
        }
        if (kind == PageKind.APPROVED_GROUP) loginRequested = false
        render()
    }

    private fun lostEngine(reason: String,code:String) {
        cancelReview(code)
        haltMessage = "STOP: $reason. Sesja zamknięta; otwórz ją ponownie."
        closeSession()
    }

    // ---- UI

    private fun render() {
        if (!::banner.isInitialized) return
        val open = session != null
        val stop = haltMessage ?: if (open && !reviewWorking() && !desktopBusy && !shareBusy && shareResolver?.status != ShareLinkResolver.Status.CONFIRMED) PocPolicy.stopMessage(kind, loginRequested) else null
        banner.text = when {
            watcherBusy -> "Synchronizacja grup z Watcherem…"
            stop != null -> stop
            !open -> "Sesja zamknięta. „Otwórz sesję” uruchamia przeglądarkę tylko dla grupy ${PocPolicy.APPROVED_GROUP_ID}."
            loginRequested && kind == PageKind.LOGIN -> "Logowanie ręczne na stronie Facebooka. Po zalogowaniu użyj „Wróć do grupy”."
            ocrBusy -> "OCR lokalnie • obrazy ${ocrLast?.images?:0}/20 • bez uploadu"
            reviewBusy&&reviewPhotosActive -> "Zapis zdjęć ofert: $reviewPosition/$reviewTotal • lokalnie, bez OCR"
            reviewBusy&&reviewOcrActive&&reviewPosition==0 -> "Etap 1/2: OCR zdjęć z pamięci • tylko lokalnie"
            reviewBusy -> (if(reviewOcrActive)"Etap 2/2: " else "")+"Odczyt postów do sprawdzenia: $reviewPosition/$reviewTotal • tylko lokalnie"
            desktopBusy -> if(desktopGate?.phase==DesktopTrial.Phase.READING)"Automatyczne przewijanie • do 30 s • tylko lokalnie" else "Ładowanie grupy • automatyczny podgląd • tylko lokalnie"
            shareBusy -> "Sprawdzanie jednego linku: do 20 s. Bez skanu."
            responseBusy -> if (responseReloadGate.active) "Trwa diagnostyka od otwarcia (25 s)." else "Trwa lokalna diagnostyka odpowiedzi (15 s)."
            shareResolver?.status == ShareLinkResolver.Status.CONFIRMED -> "Link zatwierdzonej grupy potwierdzony. Bez skanu."
            scanning -> "Trwa skan (max ${PocPolicy.MAX_POSTS} postów, ${PocPolicy.SCAN_TIMEOUT_MS / 1000} s)…"
            kind == PageKind.APPROVED_POST -> "Post zatwierdzonej grupy — podgląd ręczny, bez skanu i automatycznego odczytu."
            kind == PageKind.APPROVED_GROUP && preferences.getBoolean(groupPreference(KEY_ONE_SCAN_USED), false) ->
                "Zatwierdzona grupa otwarta. Limit jednego skanu testowego wykorzystany; wyniki dostępne lokalnie."
            kind == PageKind.APPROVED_GROUP -> "Zatwierdzona grupa otwarta. Możesz uruchomić jeden skan."
            else -> "Sesja otwarta (${kind.name})."
        }
        banner.setBackgroundColor(if (stop != null) Color.parseColor("#B3261E") else Color.parseColor("#1E5AA8"))

        val canScan = open && !reviewWorking() && !desktopBusy && !shareBusy && !responseBusy && !scanning && stop == null && !preferences.getBoolean(groupPreference(KEY_ONE_SCAN_USED), false) && PocPolicy.canScan(kind) && channel?.isConnected == true
        buttons["open"]?.isEnabled = !watcherBusy
        buttons["open"]?.text = if(ocrBusy) "Przerwij OCR" else if(reviewClosing) "Kończenie uzupełniania" else if(reviewBusy&&reviewPhotosActive) "Przerwij zdjęcia" else if(reviewBusy) "Przerwij uzupełnianie" else if(desktopBusy) "Przerwij próbę" else if (open) "Zamknij sesję" else "Otwórz sesję"
        listOf("group", "login", "back").forEach { buttons[it]?.isEnabled = open && !reviewWorking() && !desktopBusy && !scanning }
        listOf("scan", "scan3").forEach { buttons[it]?.isEnabled = canScan }
        buttons["responses"]?.isEnabled = open && !reviewWorking() && !desktopBusy && !responseBusy && !visibleBusy && !scanning && !inspectingDom && kind == PageKind.APPROVED_GROUP && progress == 100 && channel?.isConnected == true
        buttons["mainTransport"]?.isEnabled = buttons["responses"]?.isEnabled == true
        buttons["document"]?.isEnabled = buttons["responses"]?.isEnabled == true
        buttons["responseLoad"]?.isEnabled = buttons["responses"]?.isEnabled == true
        buttons["responseLoadScroll"]?.isEnabled = buttons["responses"]?.isEnabled == true
        buttons["responseScroll"]?.isEnabled = buttons["responses"]?.isEnabled == true
        buttons["dom"]?.isEnabled = open && !responseBusy && !scanning && !inspectingDom &&
            kind == PageKind.APPROVED_GROUP && channel?.isConnected == true

        buttons["sharedLink"]?.isEnabled = buttons["responses"]?.isEnabled == true
        buttons["desktopPreview"]?.isEnabled = buttons["responses"]?.isEnabled == true
        buttons["tools"]?.isEnabled = !watcherBusy && !reviewWorking() && !desktopBusy && !shareBusy && !responseBusy && !visibleBusy && !scanning && !inspectingDom && !measuringLoad
        if(::offersTab.isInitialized){
            val enabled=!busyForTabs()
            facebookTab.isEnabled=enabled;offersTab.isEnabled=enabled
            offersTab.text="Oferty (${displayedRows().count{OfferQuality.reason(it,offerPictures(it.postId).count{b->!b.isRecycled},savedResult?.postTexts?.get(it.postId))==null}})"
        }
        listOf("desktopResult","reviewResult","ocrResult","deleteResults","savedOcr","photoDiagnosis","watcherGroups","watcherConnect").forEach{buttons[it]?.isEnabled=!busyForTabs()}
        buttons["savedOcr"]?.isEnabled=!busyForTabs()&&!archiveWritePending&&savedResult?.photos?.any{it.crop}==true
        if(deletingResults||ocrBusy||reviewWorking())buttons.filterKeys{it!="open"}.values.forEach{it.isEnabled=false}
        val p = probe
        diagnostics.text = buildString {
            appendLine("STAN: ${banner.text}")
            appendLine("PRÓBA SKANU: " + scanAttemptSummary())
            appendLine()
            appendLine("Silnik: GeckoView ${org.mozilla.geckoview.BuildConfig.MOZ_APP_VERSION} • rozszerzenie: ${if (extension != null) "zainstalowane" else extensionError ?: "instalacja…"}")
            appendLine("User-Agent: ${userAgent ?: "—"}")
            appendLine("UA zawiera „; wv”: ${userAgent?.contains("; wv") ?: "—"} • nadpisany: nie")
            appendLine("Adres: ${if (shareResolver != null) "link operatora (ukryty)" else PocPolicy.sanitize(url)} • typ: $kind • ładowanie: $progress%")
            appendLine("Tytuł: ${if (shareResolver != null) "—" else title ?: "—"}")
            appendLine("Port rozszerzenia: ${if (channel?.isConnected == true) "połączony" else "brak"} • odrzucone porty: ${channel?.untrustedPorts ?: 0}")
            if (p != null && shareResolver == null) appendLine("DOM (${p.host}${p.path}): elementy ${p.elements}, formularze ${p.forms}, pola ${p.inputs}, hasła ${p.passwordInputs}, posty ${p.articles}, iframe ${p.iframes}, stan ${p.readyState}")
            appendLine("Błąd ładowania: ${if (shareResolver != null && lastLoadError != null) "błąd (adres ukryty)" else lastLoadError ?: "brak"}")
            append("Zablokowane przejścia: $blockedNavigations${lastBlockedHost?.let { " (ostatnie: $it)" } ?: ""}")
        }
    }

    private fun buildLayout(): View {
        val dp = resources.displayMetrics.density
        fun button(key: String, label: String, onClick: () -> Unit) = Button(this).apply {
            text = label
            isAllCaps = false
            textSize = 13f
            tag = "poc.tool.$key"
            setOnClickListener {
                if (key in setOf("open", "group", "tools")) onClick()
                else { diagnosticsDialog?.dismiss(); window.decorView.post { if (lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) {
                    if(key !in setOf("desktopResult","reviewResult","ocrResult","lastShareLinkResult","results","beaconNoGo","savedOcr","photoDiagnosis"))selectContentTab(false)
                    onClick()
                } } }
            }
            buttons[key] = this
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        fun row(vararg views: View) = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            views.forEach(::addView)
        }
        banner = TextView(this).apply {
            maxLines = 3
            ellipsize = android.text.TextUtils.TruncateAt.END
            setTextColor(Color.WHITE)
            textSize = 14f
            setPadding((12 * dp).toInt(), (4 * dp).toInt(), (12 * dp).toInt(), (4 * dp).toInt())
        }
        geckoView = GeckoView(this).apply {
            tag = "poc.browser"
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
        val info = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            setPadding((8 * dp).toInt(), (4 * dp).toInt(), (8 * dp).toInt(), (4 * dp).toInt())
            addView(LinearLayout(this@PocActivity).apply {
                orientation = LinearLayout.VERTICAL
                addView(diagnostics)
                addView(output)
            })
        }
        fastScrollOption = CheckBox(this).apply {
            tag = "poc.fastScroll"
            text = "Przewijanie 4×: co 0,5 s (max 5 kroków)"
            isChecked = false
        }
        val toolPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(row(button("lastShareLinkResult", "Ostatni wynik linku") { showLastShareResult() }))
            addView(row(button("sharedLink", "Sprawdź udostępniony link") { checkSharedLink() }))
            addView(row(button("mainTransport", "Mechanizm rozszerzenia • 20 s") { checkMainTransport() }))
            addView(fastScrollOption)
            addView(row(button("login", "Zaloguj się") { load(PocPolicy.LOGIN_URL, login = true) },
                button("back", "Wróć do grupy") { load(PocPolicy.APPROVED_GROUP_URL, login = false) }))
            addView(row(
                button("scan", "Skanuj widoczne") { scan(scrolls = 0) },
                button("scan3", "Skanuj + przewiń 3×") { scan(scrolls = 3) },
            ))
            addView(row(button("responses", "Sprawdź dane sieciowe") { checkResponses() }, button("responseScroll", "Dane + przewijanie") { checkResponses(autoScroll = true) }))
            addView(row(button("beaconNoGo", "Beacon: wynik NO_GO") { AlertDialog.Builder(this@PocActivity).setTitle("Beacon — NO_GO").setMessage("Test kontrolny GeckoView: serwer zwrócił niepuste dane, ale filtr Beacon nie otrzymał bajtów. Silnik przerywa odbiór odpowiedzi Beacon. Nie włączamy tego odczytu na Facebooku; kolejne przewijanie nie naprawi transportu. Brak dostarczonych bajtów nie dowodzi pustej odpowiedzi serwera ani braku postów. Dotychczasowe tryby pozostają bez zmian.").setPositiveButton("Zamknij", null).show() }))
            addView(row(button("document", "Dokument grupy • lokalnie") { checkResponseLoad(document = true) }))
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
            addView(TextView(this@PocActivity).apply { text = "Raport i stan sesji"; textSize = 16f })
            addView(info)
        }
        toolPanel.visibility=View.GONE
        val mainTools=LinearLayout(this).apply{
            orientation=LinearLayout.VERTICAL
            addView(android.widget.ImageView(this@PocActivity).apply{
                setImageResource(R.drawable.metron_company)
                contentDescription="MetrON — Nieruchomości i Inwestycje"
                scaleType=android.widget.ImageView.ScaleType.FIT_CENTER
                setBackgroundColor(Color.rgb(6,15,28))
                layoutParams=LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,(112*dp).toInt())
            })
            addView(row(button("desktopPreview","Automatyczny podgląd • 30 s"){startDesktopPreview()}))
            addView(row(button("desktopResult","Oferty"){selectContentTab(true)}))
            addView(row(button("watcherConnect","Połącz / synchronizuj Watchera"){watcherConnection()}))
            addView(row(button("automation","Automat 3× dziennie / stan"){automationSettings()}))
            addView(row(button("watcherGroups","Wybierz grupę Watchera"){chooseWatcherGroup()}))
            addView(row(button("deleteResults","Kasuj bazę"){askDeleteResults()}))
            addView(row(button("reviewResult","Ostatni wynik uzupełniania"){showReviewResult()}))
            addView(row(button("ocrResult","Ostatni wynik OCR"){showOcrReport()}))
            addView(row(button("savedOcr","OCR zapisanych zdjęć"){askSavedOcr()}))
            addView(row(button("photoDiagnosis","Ostatnia diagnoza zdjęcia"){showPhotoDiagnosis()}))
            addView(row(Button(this@PocActivity).apply{text="Archiwum narzędzi";setOnClickListener{toolPanel.visibility=if(toolPanel.visibility==View.VISIBLE)View.GONE else View.VISIBLE}}))
            addView(toolPanel)
        }
        val menuScroll = ScrollView(this).apply { addView(mainTools) }
        diagnosticsDialog = AlertDialog.Builder(this).setTitle("Narzędzia i raport")
            .setView(menuScroll).setNegativeButton("Wróć do Facebooka", null).create()
        val root = LinearLayout(this).apply {
            tag = "poc.root"
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#FAFAFC"))
            addView(banner)
            automationSummary=TextView(this@PocActivity).apply{
                tag="poc.automation.summary";text="Automat — podgląd postępu";textSize=12f;maxLines=1
                includeFontPadding=false;ellipsize=android.text.TextUtils.TruncateAt.END
                setPadding((10*dp).toInt(),dp.toInt(),(10*dp).toInt(),dp.toInt())
                setBackgroundColor(Color.parseColor("#E8F1FA"));isClickable=true;isFocusable=true
                setOnClickListener{startActivity(Intent(this@PocActivity,ScanStatusActivity::class.java))}
            }
            addView(automationSummary)
            addView(row(
                button("open", "Otwórz sesję") { if(ocrBusy)cancelOcr("CANCELLED") else if(reviewClosing)Unit else if(reviewBusy)cancelReview("CANCELLED") else if(desktopBusy)finishDesktop("CANCELLED",show=false) else if (session == null) askConsentAndOpen() else closeSession() },
                button("group", "Otwórz grupę") { load(PocPolicy.APPROVED_GROUP_URL, login = false) },
                button("tools", "Narzędzia / raport") { diagnosticsDialog?.show() },
            ))
            addView(LinearLayout(this@PocActivity).apply{
                orientation=LinearLayout.VERTICAL
                layoutParams=LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,0,1f)
                facebookTab=Button(this@PocActivity).apply{tag="poc.tab.facebook";text="Facebook";isSelected=true;setTypeface(null,Typeface.BOLD);isAllCaps=false;setOnClickListener{selectContentTab(false)}}
                offersTab=Button(this@PocActivity).apply{tag="poc.tab.offers";text="Oferty (0)";isAllCaps=false;setOnClickListener{selectContentTab(true)}}
                addView(row(facebookTab,offersTab).apply{
                    for(i in 0 until childCount)getChildAt(i).layoutParams=LinearLayout.LayoutParams(0,(48*dp).toInt(),1f)
                })
                addView(FrameLayout(this@PocActivity).apply{
                    layoutParams=LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,0,1f)
                    geckoView.layoutParams=FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.MATCH_PARENT)
                    addView(geckoView)
                    offersPanel=OffersPanel(this@PocActivity,{openOffer(it)},{showReviewOrDesktopResult()},onEnrich={askReviewData()},onOcr={askOcr()},ocrAvailable={desktopThumbnails.ocrRows(it).isNotEmpty()},ocrResult={if(desktopRows.isEmpty())savedResult?.ocr?.firstOrNull{r->r.postId==it} else ocrResults[it]},onDelete={askDeleteResults()},onSavedOcr={askSavedOcr()},savedCrops={savedResult?.photos?.count{it.crop}?:0},onInspect={askReviewData(withOcr=true,selectedPostId=it.postId)},onPhotos={askPhotos()},photoAvailable=::hasOfferPhoto).apply{
                        layoutParams=FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.MATCH_PARENT)
                        visibility=View.GONE
                        showRows(emptyList())
                    }
                    addView(offersPanel)
                })
            })
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
