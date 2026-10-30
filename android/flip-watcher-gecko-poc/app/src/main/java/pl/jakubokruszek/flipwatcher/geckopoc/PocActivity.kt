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
    private var deletingResults=false
    internal var deleteResultsDialog:AlertDialog?=null; private set
    private fun displayedRows()=desktopRows.ifEmpty{savedResult?.rows.orEmpty()}
    private fun savedNotice()=savedResult?.let{"Zachowany wynik: "+java.text.DateFormat.getDateTimeInstance().format(java.util.Date(it.savedAt))+". Dane historyczne; nowy odczyt wymaga nowej zgody."}
    private fun showSavedResult(){
        if(!::offersPanel.isInitialized||desktopRows.isNotEmpty())return
        offersPanel.showRows(savedResult?.rows.orEmpty(),archiveError?:savedNotice(),thumbnails={savedThumbnails.rows(it)},archived=true)
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
        if(android.os.Build.VERSION.SDK_INT>=33)setRecentsScreenshotEnabled(false)
        PocPolicy.selectGroup(preferences.getString("selected_watcher_group",WatcherGroups.LEGACY_GROUP)
            ?.takeIf{WatcherGroups.find(it)!=null}?:WatcherGroups.LEGACY_GROUP)
        setContentView(buildLayout())
        readSavedResult()
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
        deleteResultsDialog?.dismiss();savedThumbnails.clear()
        lastShareResultDialog?.dismiss()
        closeSession()
        super.onDestroy()
    }

    override fun onResume(){super.onResume();if(!reviewWorking())runCatching{session?.setActive(true)};window.decorView.post{showSavedResult();showPendingPhotosReport();showPendingReviewReport();showPendingOcrReport()}}

    override fun onPause() {
        ocrConsentDialog?.dismiss();ocrConsentDialog=null;cancelOcr("PAUSED")
        reviewConsentDialog?.dismiss();reviewConsentDialog=null;cancelReview("PAUSED")
        desktopConsentDialog?.dismiss();desktopConsentDialog=null
        finishDesktop("PAUSED",show=false);clearDesktopDetails()
        shareDialog?.dismiss(); shareDialog = null
        lastShareResultDialog?.dismiss(); lastShareResultDialog = null
        finishShare("PAUSED", clear = true)
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
                if(reviewWorking()||!lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)||session!==currentSession||channel!==currentChannel||url!=target||kind!=PageKind.APPROVED_GROUP||desktopBusy||shareBusy||responseBusy||visibleBusy||scanning||inspectingDom||measuringLoad||progress!=100||!currentChannel.isConnected)return@accept
                reviewLast=null;ocrLast=null;photoLast=null;photoReportPending=false;stopVisiblePosts();finishShare("CANCELLED",clear=true);clearDesktopDetails()
                val gate=DesktopTrial(target,{android.os.SystemClock.elapsedRealtime()})
                if(!gate.begin(true)){publishDesktop(DesktopSummary.create("NO_CONSENT_OR_CONTEXT",0),emptyList());return@accept}
                desktopFollowUp=if(automaticPhotos)({if(session===currentSession&&channel===currentChannel&&kind==PageKind.APPROVED_GROUP&&!busyForTabs()&&lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED))askPhotos(preconsented=true)}) else null
                clearDesktopDetails();geckoView.requestFocus();DesktopKeyboard.dismiss(geckoView);desktopGate=gate;desktopBusy=true;desktopRows=emptyList();desktopNonce=UUID.randomUUID().toString();render()
                desktopJob=lifecycleScope.launch{
                    val result=DesktopSessionPreview.run(currentSession,currentChannel,gate,desktopNonce!!,target,{url},pageReady={pageLoaded&&progress==100},view=geckoView,images=desktopThumbnails,baseline=false,gesture=false,fastScroll=true)
                    if(desktopGate===gate&&desktopBusy){userAgent=result.userAgent;finishDesktop(result.reason,result.reply)}
                }
        })
        desktopConsentDialog?.setOnDismissListener{desktopConsentDialog=null}
        desktopConsentDialog?.show()
    }
    private fun finishDesktop(reason:String,reply:DesktopReply?=null,show:Boolean=true){
        if(!desktopBusy)return
        val followUp=desktopFollowUp.takeIf{reason=="DONE"};desktopFollowUp=null
        val gate=desktopGate;gate?.stop(reason)
        desktopBusy=false;desktopJob?.cancel();desktopJob=null
        desktopNonce?.let{GeckoHost.background.abortDesktop(it)};desktopNonce=null;channel?.abortDesktop()
        if(reason!="DONE")session?.stop()
        val summary=DesktopSummary.create(reason,gate?.requests?:0,reply)
        publishDesktop(summary,if(reason=="DONE")reply?.rows?:emptyList() else emptyList(),show)
        render()
        if(followUp!=null){val completedRows=desktopRows;lifecycleScope.launch{
            val deadline=android.os.SystemClock.elapsedRealtime()+5000
            while(archiveWritePending&&desktopRows===completedRows&&android.os.SystemClock.elapsedRealtime()<deadline)delay(50)
            if(!archiveWritePending&&desktopRows===completedRows&&completedRows.isNotEmpty())followUp()
        }}
    }
    internal fun publishDesktop(summary:DesktopSummary,rows:List<DesktopRow>,show:Boolean=true){
        cancelOcr("CONTEXT");ocrResults.clear()
        desktopRows=rows.take(20)
        if(summary.reason=="DONE"&&desktopRows.isNotEmpty())saveResult(photos=true)
        desktopThumbnails.retain(desktopRows.map{it.postId}.toSet())
        val saved=runCatching{desktopPrefs.edit().putString("last",summary.encode()).commit()}.getOrDefault(false)
        output.text=summary.report()+if(saved)"" else "\nUWAGA: nie zapisano raportu; skopiuj teraz."
        if(::offersPanel.isInitialized){if(desktopRows.isEmpty())showSavedResult() else offersPanel.showRows(desktopRows,thumbnails=::offerPictures)}
        if(show&&lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED))selectContentTab(true)
        render()
    }
    private fun clearDesktopDetails(){
        cancelOcr("CONTEXT");ocrResults.clear()
        desktopRows=emptyList();desktopResultText?.text="";desktopResultText=null;desktopResultDialog?.dismiss();desktopResultDialog=null
        if(::offersPanel.isInitialized)offersPanel.showRows(emptyList())
        desktopThumbnails.clear()
        showSavedResult()
        if(::offersTab.isInitialized)offersTab.text="Oferty (${displayedRows().count{DesktopSummary.eligible(it)}})"
    }
    private fun busyForTabs()=deletingResults||ocrBusy||reviewWorking()||desktopBusy||shareBusy||responseBusy||visibleBusy||scanning||inspectingDom||measuringLoad
    private fun selectContentTab(offers:Boolean){
        if(busyForTabs()||!::offersPanel.isInitialized)return
        if(offers&&desktopRows.isEmpty())showSavedResult()
        geckoView.visibility=if(offers)View.GONE else View.VISIBLE
        offersPanel.visibility=if(offers)View.VISIBLE else View.GONE
        facebookTab.isSelected=!offers;offersTab.isSelected=offers
        facebookTab.setTypeface(null,if(offers)Typeface.NORMAL else Typeface.BOLD)
        offersTab.setTypeface(null,if(offers)Typeface.BOLD else Typeface.NORMAL)
        if(offers)geckoView.clearFocus()
    }
    private fun cancelReview(code:String){
        if(!reviewBusy)return
        val photos=reviewPhotosActive
        if(photos){savePhotos((photoLast?:PhotoSummary("INTERRUPTED",reviewTotal,0)).copy(reason=when(code){"PAUSED","CANCELLED"->code;"DEADLINE"->"TIMEOUT";else->"ERROR"},review=reviewSnapshot?.stopped(code)));photoReportPending=true}
        if(reviewOcrActive){saveOcr((ocrLast?:OcrSummary("INTERRUPTED",reviewTotal,0,0,0,0)).copy(reason=if(code in setOf("PAUSED","CANCELLED"))code else if(code=="DEADLINE")"TIMEOUT" else "ERROR",reviewFailure=reviewSnapshot?.stopped(code)));ocrReportPending=true;reviewOcrActive=false}
        saveReviewResult((reviewSnapshot?:ReviewDataSummary("INTERRUPTED",reviewTotal,0,0,0,0,0,0,0)).stopped(code));reviewReportPending=!photos
        reviewBusy=false;reviewClosing=true;reviewJob?.cancel();clearDesktopDetails()
        output.text="Uzupełnianie zatrzymane: $code. Ostatni zapisany wynik pozostaje w bazie; brak skanu i uploadu.";render()
    }
    private fun saveReviewResult(value:ReviewDataSummary){
        reviewSnapshot=value;reviewLast=value
        runCatching{reviewPrefs.edit().putString("last",value.encode()).commit()}
    }
    internal fun publishReviewFailure(value:ReviewDataSummary,preservePreview:Boolean=false){
        require(value.reason!="DONE")
        val keep=preservePreview&&value.reason=="NO_OWN_POST"&&session!=null&&haltMessage==null&&kind==PageKind.APPROVED_GROUP&&lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)
        if(!keep)clearDesktopDetails();saveReviewResult(value);reviewReportPending=true;render();showPendingReviewReport()
    }
    private fun showReviewResult(){
        val result=reviewLast?:ReviewDataSummary.decode(reviewPrefs.getString("last",null))
        reviewReportPending=false;desktopResultDialog?.dismiss()
        desktopResultDialog=AlertDialog.Builder(this).setTitle("Wynik uzupełniania — lokalnie")
            .setMessage(result?.report()?:"Brak zapisanej próby uzupełniania. Raport przeglądania grupy jest osobnym wynikiem.")
            .setPositiveButton("OK",null).create().also{it.show()}
    }
    private fun showPendingReviewReport(){
        if(!reviewReportPending||reviewWorking()||isFinishing||isDestroyed||!lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED))return
        val result=reviewLast?:return
        if(result.reason!="DONE"&&desktopRows.isEmpty()){
            showSavedResult()
            selectContentTab(true)
        }
        if(result.reason=="NO_OWN_POST"&&desktopRows.isNotEmpty()){
            offersPanel.showRows(desktopRows,"Nie odczytano szczegółów. Dotychczasowe wyniki grupy pozostają dostępne; możesz otworzyć post ręcznie.",thumbnails=::offerPictures)
            selectContentTab(true)
        }
        showReviewResult()
    }
    private fun showReviewOrDesktopResult(){
        if(photoLast!=null){showPhotosReport();return}
        if(ocrLast!=null){showOcrReport();return}
        if(reviewLast!=null||desktopRows.isEmpty()&&ReviewDataSummary.decode(reviewPrefs.getString("last",null))!=null)showReviewResult() else showDesktopResult()
    }
    private fun saveOcr(value:OcrSummary){photoLast=null;ocrLast=value;runCatching{ocrPrefs.edit().putString("last",value.encode()).commit()}}
    private fun showOcrReport(){
        ocrReportPending=false;desktopResultDialog?.dismiss()
        val value=ocrLast?:OcrSummary.decode(ocrPrefs.getString("last",null))
        desktopResultDialog=AlertDialog.Builder(this).setTitle("OCR — wynik lokalny")
            .setMessage(value?.brief()?:"Brak zapisanej próby OCR.")
            .setNeutralButton("Diagnostyka"){_,_->desktopResultDialog=AlertDialog.Builder(this).setTitle("OCR — diagnostyka").setMessage(value?.report()?:"Brak raportu.").setPositiveButton("OK",null).create().also{it.show()}}
            .setPositiveButton("OK",null).create().also{it.show()}
    }
    private fun showPendingOcrReport(){if(ocrReportPending&&!ocrBusy&&!isFinishing&&!isDestroyed&&lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED))showOcrReport()}
    private fun cancelOcr(reason:String){
        if(!ocrBusy)return
        ocrBusy=false;ocrEpoch++;ocrResults.clear();ocrJob?.cancel()
        saveOcr((ocrLast?:OcrSummary("INTERRUPTED",0,0,0,0,0)).copy(reason=if(reason in setOf("PAUSED","CANCELLED","CONTEXT"))reason else "ERROR"));ocrReportPending=true
    }
    private fun askOcr(preconsented:Boolean=false){
        if(ReviewDataGate.queue(desktopRows).isNotEmpty()){askReviewData(withOcr=true,preconsented=preconsented);return}
        if(busyForTabs()||kind!=PageKind.APPROVED_GROUP||!lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED))return
        val original=session?:return;val source=channel?:return;val generation=source.connectionGeneration;val target=url;val snapshot=desktopRows
        val count=snapshot.count{(DesktopPresentation.reviewable(it)||DesktopSummary.eligible(it))&&desktopThumbnails.ocrRows(it.postId).isNotEmpty()}
        // Prefer already identity-bound crops: manual rows must not force a new
        // navigation and prevent OCR of images we already hold in RAM.
        if(count==0){
            if(ReviewDataGate.queue(snapshot).isNotEmpty())askReviewData(withOcr=true,preconsented=preconsented)
            return
        }
        ocrConsentDialog?.dismiss()
        val start=start@{
                ocrConsentDialog=null
                if(busyForTabs()||session!==original||channel!==source||url!=target||desktopRows!==snapshot||kind!=PageKind.APPROVED_GROUP||!lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED))return@start
                ocrResults.clear();ocrReportPending=false;val epoch=++ocrEpoch;ocrBusy=true;saveOcr(OcrSummary("INTERRUPTED",count,0,0,0,0));render()
                val live={ocrBusy&&ocrEpoch==epoch&&session===original&&channel===source&&source.isConnected&&source.connectionGeneration==generation&&url==target&&kind==PageKind.APPROVED_GROUP&&desktopRows===snapshot&&lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)&&window.decorView.hasWindowFocus()}
                ocrJob=lifecycleScope.launch{
                    try{
                        delay(200)
                        val outcome=kotlinx.coroutines.withTimeout(120000){OcrBatch.run(snapshot,true,{desktopThumbnails.ocrRows(it).size},live,
                            read={id,index->val photo=desktopThumbnails.ocrRows(id).getOrNull(index);val owned=photo?.takeIf{!it.isRecycled}?.copy(android.graphics.Bitmap.Config.ARGB_8888,false);if(owned==null)null else LocalOcr.readOwned(owned)},
                            project={id,texts->GeckoHost.background.ocrFields(id,texts,true)},now={android.os.SystemClock.elapsedRealtime()},snapshot={if(ocrBusy&&ocrEpoch==epoch)saveOcr(it.copy(reason="INTERRUPTED"))})}
                        if(!ocrBusy||ocrEpoch!=epoch)return@launch
                        ocrBusy=false;saveOcr(outcome.summary);ocrReportPending=true
                        if(outcome.summary.reason=="DONE"){ocrResults.putAll(outcome.rows);saveResult()} else if(outcome.summary.reason in setOf("CONTEXT","PROTOCOL"))clearDesktopDetails()
                        offersPanel.showRows(desktopRows,"OCR: ${outcome.summary.suggestions} wyników do sprawdzenia",thumbnails=::offerPictures)
                    }catch(_:kotlinx.coroutines.TimeoutCancellationException){if(ocrBusy&&ocrEpoch==epoch){ocrBusy=false;saveOcr((ocrLast?:OcrSummary("INTERRUPTED",count,0,0,0,0)).copy(reason="TIMEOUT"));ocrReportPending=true}}
                    catch(e:kotlinx.coroutines.CancellationException){throw e}
                    catch(_:Exception){if(ocrBusy&&ocrEpoch==epoch){ocrBusy=false;saveOcr((ocrLast?:OcrSummary("INTERRUPTED",count,0,0,0,0)).copy(reason="ERROR"));ocrReportPending=true}}
                    finally{if(ocrEpoch==epoch)ocrJob=null;render();showPendingOcrReport()}
                }

        }
        if(preconsented){start();return}
        ocrConsentDialog=AlertDialog.Builder(this).setTitle("OCR lokalnie — nowa zgoda")
            .setMessage("Odczytać napisy z widocznych wcześniej zdjęć przypisanych do $count postów zatwierdzonej grupy? Maks. 20 obrazów, 20 postów i 2 minuty. Model OCR jest w APK i działa na telefonie bez pobierania modelu. Bez wysyłania zdjęć lub wyników, dodatkowego pobierania mediów, skanu i kolektora.\n\nPola OCR mogą być błędne: będą pokazane osobno, DO SPRAWDZENIA. Nie nadpisują danych tekstowych. Wycinki i wyniki zapisują się w prywatnej bazie lokalnej. Pauza zatrzymuje odczyt, ale nie usuwa zachowanego wyniku. Zapis usuwa przycisk Kasuj bazę. Każda próba wymaga nowej zgody.")
            .setNegativeButton("Anuluj",null).setPositiveButton("Zgadzam się"){_,_->start()}
            .create().also{it.setCanceledOnTouchOutside(false);it.show()}
    }

    internal fun askSavedOcr(){
        if(busyForTabs()||!lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED))return
        if(archiveWritePending){android.widget.Toast.makeText(this,"Trwa zapis wyniku. Spróbuj za chwilę.",android.widget.Toast.LENGTH_SHORT).show();return}
        val saved=savedResult?:return
        val count=saved.photos.count{it.crop}
        if(count==0){AlertDialog.Builder(this).setTitle("Brak wycinków OCR").setMessage("Zapisane miniatury nie zastępują pełniejszych wycinków. Wybierz Sprawdź zdjęcie tego posta, aby sprawdzić brak przechwycenia.").setPositiveButton("OK",null).show();return}
        ocrConsentDialog=AlertDialog.Builder(this).setTitle("OCR zapisanych zdjęć")
            .setMessage("Odczytać do 20 zapisanych wycinków zdjęć, bez otwierania Facebooka i bez nowego wyszukiwania? Do 2 minut. Wyniki osobno, do sprawdzenia. Każdy ukończony odczyt jest zapisywany. Pauza zatrzymuje dalsze rozpoznawanie; wcześniejsze dane pozostają. Bez uploadu.")
            .setNegativeButton("Anuluj",null).setPositiveButton("Uruchom OCR"){_,_->startSavedOcr(saved)}.create().also{it.show()}
    }
    private fun startSavedOcr(saved:SavedResult){
        ocrConsentDialog=null
        if(busyForTabs()||savedResult!==saved||!lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED))return
        val epoch=++ocrEpoch;ocrBusy=true;ocrReportPending=false;saveOcr(OcrSummary("INTERRUPTED",saved.rows.size,0,0,0,0));render()
        val live={ocrBusy&&ocrEpoch==epoch&&lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)}
        ocrJob=lifecycleScope.launch{
            try{
                GeckoHost.collectorExtension(this@PocActivity)
                if(!GeckoHost.background.awaitPort(8000)||!live())throw IllegalStateException("LOCAL_PARSER")
                val outcome=kotlinx.coroutines.withTimeout(120000){SavedOcr.run(saved,true,live,
                    read={photo->val bitmap=kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO){android.graphics.BitmapFactory.decodeByteArray(photo.jpeg,0,photo.jpeg.size)};if(bitmap==null)null else LocalOcr.readOwned(bitmap)},
                    project={id,texts->GeckoHost.background.ocrFields(id,texts,true)},now={android.os.SystemClock.elapsedRealtime()},
                    progress={if(live())saveOcr(it)},checkpoint={rows->if(live())saveResult(saved.rows,rows)})}
                if(live()&&outcome.summary.reason=="DONE"&&outcome.rows.isNotEmpty()){
                    val persisted=ResultArchiveJobs.read(this@PocActivity).getOrThrow()?:throw IllegalStateException("SAVE_FAILED")
                    if(outcome.rows.values.any{candidate->persisted.ocr.none{it==candidate}})throw IllegalStateException("SAVE_FAILED")
                }
                if(live()){
                    if(desktopRows==saved.rows){ocrResults.putAll(saved.ocr.associateBy{it.postId});ocrResults.putAll(outcome.rows);offersPanel.showRows(desktopRows,"OCR zapisanych zdjęć: ${outcome.summary.suggestions} nowych sugestii do sprawdzenia",thumbnails=::offerPictures)}
                    saveOcr(outcome.summary);ocrBusy=false;ocrReportPending=true
                }
            }catch(_:kotlinx.coroutines.TimeoutCancellationException){if(live()){saveOcr((ocrLast?:OcrSummary("TIMEOUT",saved.rows.size,0,0,0,0)).copy(reason="TIMEOUT"));ocrReportPending=true}}
            catch(e:kotlinx.coroutines.CancellationException){throw e}
            catch(_:Exception){if(live()){saveOcr((ocrLast?:OcrSummary("ERROR",saved.rows.size,0,0,0,0)).copy(reason="ERROR"));ocrBusy=false;ocrReportPending=true}}
            finally{if(ocrEpoch==epoch){ocrJob=null;ocrBusy=false;render();showSavedResult();showPendingOcrReport()}}
        }
    }
    private var reviewPhotosActive=false
    private var photoLast:PhotoSummary?=null
    private var photoReportPending=false
    private val photoPrefs get()=getSharedPreferences(groupPreference("photo_counts_v1"),MODE_PRIVATE)
    private fun offerPictures(id:String)=desktopThumbnails.rows(id).ifEmpty{savedThumbnails.rows(id)}
    private fun hasOfferPhoto(id:String)=desktopThumbnails.rows(id).isNotEmpty()||savedResult?.photos?.any{it.postId==id&&!it.crop}==true
    private fun savePhotos(value:PhotoSummary){photoLast=value;photoPrefs.edit().putString("last",value.encode()).commit()}
    private fun showPhotosReport(){
        photoReportPending=false;desktopResultDialog?.dismiss()
        val value=photoLast?:PhotoSummary.decode(photoPrefs.getString("last",null))
        desktopResultDialog=AlertDialog.Builder(this).setTitle("Zdjęcia ofert — zapis lokalny").setMessage(value?.brief()?:"Brak zapisanej próby.")
            .setNeutralButton("Diagnostyka"){_,_->desktopResultDialog=AlertDialog.Builder(this).setTitle("Zdjęcia — diagnostyka").setMessage(value?.report()?:"Brak raportu.").setPositiveButton("OK",null).create().also{it.show()}}
            .setPositiveButton("OK",null).create().also{it.show()}
    }
    private fun showPendingPhotosReport(){if(photoReportPending&&!reviewWorking()&&!isFinishing&&!isDestroyed&&lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED))showPhotosReport()}
    private suspend fun persistPhotos(rows:List<DesktopRow>,ocr:List<DesktopRow>,images:DesktopThumbnails):Boolean {
        archiveWritePending=true;val revision=++archiveRevision
        return try{ResultArchiveJobs.saveAwait(this,rows,ocr,images)}finally{if(!isDestroyed&&revision==archiveRevision)readSavedResult()}
    }
    internal fun askPhotos(preconsented:Boolean=false){
        if(busyForTabs()||!lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED))return
        if(archiveWritePending){android.widget.Toast.makeText(this,"Trwa zapis wyniku. Spróbuj za chwilę.",android.widget.Toast.LENGTH_SHORT).show();return}
        val rows=displayedRows();val queue=PhotoCollection.queue(rows,::hasOfferPhoto)
        if(queue.isEmpty()){
            if(preconsented)return
            AlertDialog.Builder(this).setTitle("Zdjęcia ofert").setMessage("Nie ma ofert ani kandydatów bez lokalnego zdjęcia. Zachowane zdjęcia pozostają w bazie.")
                .setNeutralButton("Ostatni raport"){_,_->showPhotosReport()}.setPositiveButton("OK",null).show();return
        }
        if(session==null||kind!=PageKind.APPROVED_GROUP||channel?.isConnected!=true){
            AlertDialog.Builder(this).setTitle("Zdjęcia zachowanych ofert").setMessage("Najpierw otwórz sesję i zatwierdzoną grupę, następnie wybierz Uzupełnij zdjęcia ofert. Zachowane wyniki pozostają; nowe wyszukiwanie nie jest potrzebne.")
                .setNegativeButton("Anuluj",null).setPositiveButton(if(session==null)"Otwórz sesję"else"Otwórz grupę"){_,_->if(session==null)askConsentAndOpen()else load(PocPolicy.APPROVED_GROUP_URL,login=false)}.show();return
        }
        val original=session?:return;val originalChannel=channel?:return
        val retainedOcr=(savedResult?.ocr.orEmpty()+ocrResults.values).associateBy{it.postId}.values.toList()
        val start=start@{
            reviewConsentDialog=null
            if(busyForTabs()||session!==original||channel!==originalChannel||!originalChannel.isConnected||displayedRows()!==rows||kind!=PageKind.APPROVED_GROUP||!lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED))return@start
            desktopResultDialog?.dismiss();desktopRows=rows;photoReportPending=false;ocrReportPending=false;reviewReportPending=false
            stopVisiblePosts();selectContentTab(false);reviewPhotosActive=true;reviewOcrActive=false;reviewBusy=true;reviewPosition=0;reviewTotal=queue.size
            saveReviewResult(ReviewDataSummary("INTERRUPTED",queue.size,0,0,0,0,0,0,0));savePhotos(PhotoSummary("INTERRUPTED",queue.size,0));render()
            reviewJob=lifecycleScope.launch{
                var saved=0;var checks:Map<String,Int> = emptyMap();var archiveRows=rows
                fun progress(reason:String,review:ReviewDataSummary?=null){savePhotos(PhotoSummary(reason,queue.size,saved,checks,review))}
                try{
                    delay(200)
                    val outcome=kotlinx.coroutines.withTimeout(180000){ReviewDataRunner.run(geckoView,original,rows,true,
                        alive={reviewBusy&&reviewPhotosActive&&session===original&&desktopRows===rows&&lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)&&geckoView.isAttachedToWindow},
                        progress={index,total->reviewPosition=index;reviewTotal=total;render()},
                        restoreActive={session===original&&lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)},
                        snapshot={if(reviewBusy)saveReviewResult(it.copy(reason="INTERRUPTED"))},originalChannel=originalChannel,photoPostIds=queue.map{it.postId},
                        onValidatedRows={validated->archiveRows=validated;saveResult(validated,retainedOcr)},
                        onBoundPost={source,row,current,live->
                            if(DesktopSummary.eligible(row)||DesktopPresentation.reviewable(row)){
                                val captured=PhotoCollection.capture(row.postId,live,
                                    capture={images->
                                        val safe=source.reviewImages(row,current,geckoView,images,true,alive=live)
                                        checks=ReviewImageChecks.add(checks,source.reviewImageOutcome,source.reviewImageFilters);progress("INTERRUPTED")
                                        safe
                                    },
                                    persist={images->persistPhotos(archiveRows.map{if(it.postId==row.postId)row else it},retainedOcr,images)},
                                    publish={images->desktopThumbnails.replacePostFrom(row.postId,images)})
                                if(captured){saved++;progress("INTERRUPTED")}
                            }
                        })}
                    if(!reviewBusy)return@launch
                    saveReviewResult(outcome.summary);progress(if(outcome.summary.reason=="DONE")"DONE"else"CONTEXT",outcome.summary)
                    if(outcome.summary.reason=="DONE"){desktopRows=outcome.rows;saveResult(outcome.rows,retainedOcr)}
                    reviewBusy=false;photoReportPending=true;reviewReportPending=false
                    offersPanel.showRows(desktopRows,"Zapisano nowe zdjęcia: $saved. OCR nie był uruchamiany.",thumbnails=::offerPictures)
                    selectContentTab(true)
                }catch(_:kotlinx.coroutines.TimeoutCancellationException){if(reviewBusy)cancelReview("DEADLINE")}
                catch(e:kotlinx.coroutines.CancellationException){throw e}
                catch(_:Exception){if(reviewBusy)cancelReview("ERROR")}
                finally{reviewClosing=false;reviewPhotosActive=false;if(!reviewBusy)reviewJob=null;render();showPendingPhotosReport()}
            }
        }
        if(preconsented){start();return}
        reviewConsentDialog=AlertDialog.Builder(this).setTitle("Uzupełnij zdjęcia ofert")
            .setMessage("Sprawdzić ${queue.size} zachowanych postów bez zdjęcia? Najpierw rozpoznane oferty, potem kandydaci do ręcznego sprawdzenia. Do jednego widocznego, potwierdzonego zdjęcia na post, maks. 20 postów i 3 minuty. Każde zdjęcie zapisuje się lokalnie przed przejściem do następnego posta. Bez OCR, nowego wyszukiwania i uploadu. Pauza lub utrata kontekstu zatrzymują dalszą pracę; ukończone zapisy pozostają.")
            .setNegativeButton("Anuluj",null).setPositiveButton("Zapisz zdjęcia"){_,_->start()}.create().also{it.setCanceledOnTouchOutside(false);it.show()}
    }

    private val photoDiagnosisPrefs get()=getSharedPreferences(groupPreference("photo_diagnosis_v1"),MODE_PRIVATE)
    private fun savePhotoDiagnosis(id:String,reason:String,details:Map<String,Int>,checks:Map<String,Int>){
        photoDiagnosisPrefs.edit().putString("last",PhotoDiagnosis(id,reason,details,checks).encode()).commit()
    }
    private fun showPhotoDiagnosis(){
        val value=PhotoDiagnosis.decode(photoDiagnosisPrefs.getString("last",null))
        AlertDialog.Builder(this).setTitle("Zdjęcie jednego posta").setMessage(value?.report()?:"Brak diagnozy. W Ofertach wybierz Sprawdź zdjęcie tego posta.").setPositiveButton("OK",null).show()
    }
    private fun askReviewData(withOcr:Boolean=false,preconsented:Boolean=false,selectedPostId:String?=null){
        if(busyForTabs())return
        val archive=if(desktopRows.isEmpty())savedResult else null
        if(archive!=null&&archiveWritePending)return
        val snapshot=archive?.rows?:desktopRows
        val queue=ReviewDataGate.queue(snapshot,selectedPostId=selectedPostId)
        if(queue.isEmpty())return
        if(session==null||kind!=PageKind.APPROVED_GROUP||channel?.isConnected!=true){
            reviewConsentDialog=AlertDialog.Builder(this).setTitle("Odczyt zachowanych postów")
                .setMessage("Zachowany wynik pozostaje w bazie. Najpierw otwórz sesję i zatwierdzoną grupę, następnie wybierz ponownie uzupełnianie lub sprawdzenie zdjęcia. Wyszukiwanie od początku nie jest potrzebne.")
                .setNegativeButton("Anuluj",null).setPositiveButton(if(session==null)"Otwórz sesję" else "Otwórz grupę"){_,_->if(session==null)askConsentAndOpen() else load(PocPolicy.APPROVED_GROUP_URL,login=false)}.show();return
        }
        val original=session?:return
        fun sourceCurrent()=if(archive!=null)desktopRows.isEmpty()&&savedResult===archive else desktopRows===snapshot
        val previousOcr=(archive?.ocr.orEmpty()+ocrResults.values).associateBy{it.postId}
        fun retainedOcr(rows:Map<String,DesktopRow>)=(previousOcr+rows).values.toList()
        val selectedOcr=if(selectedPostId!=null)1 else snapshot.count{DesktopPresentation.reviewable(it)||DesktopSummary.eligible(it)}
        val cachedChannel=channel;val cachedGeneration=cachedChannel?.connectionGeneration;val cachedUrl=url
        if(busyForTabs()||queue.isEmpty()||kind!=PageKind.APPROVED_GROUP||!lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED))return
        reviewConsentDialog?.dismiss()
        val start=start@{
                reviewConsentDialog=null
                photoLast=null
                if(busyForTabs()||session!==original||!sourceCurrent()||kind!=PageKind.APPROVED_GROUP||!lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED))return@start
                if(archive!=null){desktopRows=snapshot;desktopThumbnails.clear()}
                if(selectedPostId!=null)savePhotoDiagnosis(selectedPostId,"NO_PROOF",emptyMap(),emptyMap())
                reviewOcrActive=withOcr;if(withOcr){ocrResults.clear();ocrReportPending=false;saveOcr(OcrSummary("INTERRUPTED",selectedOcr,0,0,0,0))};stopVisiblePosts();selectContentTab(false);reviewLast=null;reviewTotal=queue.size;reviewPosition=0;reviewReportPending=false;saveReviewResult(ReviewDataSummary("INTERRUPTED",queue.size,0,0,0,0,0,0,0));reviewBusy=true;render()
                reviewJob=lifecycleScope.launch{
                    try{
                        delay(200)
                        val pendingOcr=linkedMapOf<String,DesktopRow>();val cachedOcr=linkedMapOf<String,DesktopRow>();var ocrImages=0;var cachedImages=0;var ocrTexts=0;var ocrErrors=0;var imageChecks:Map<String,Int> = emptyMap()
                        fun ocrProgress(reason:String,failure:ReviewDataSummary?=null,completed:ReviewDataSummary?=null){if(withOcr)saveOcr(OcrSummary(reason,selectedOcr,ocrImages,ocrTexts,pendingOcr.size,ocrErrors,failure,completed,imageChecks))}
                        val outcome=kotlinx.coroutines.withTimeout(180000){
                        if(withOcr&&selectedPostId==null&&snapshot.any{desktopThumbnails.ocrRows(it.postId).isNotEmpty()}){
                            val cacheLive={reviewBusy&&session===original&&desktopRows===snapshot&&channel===cachedChannel&&cachedChannel?.isConnected==true&&cachedChannel.connectionGeneration==cachedGeneration&&url==cachedUrl&&kind==PageKind.APPROVED_GROUP&&lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)&&window.decorView.hasWindowFocus()}
                            val cached=OcrBatch.run(snapshot,true,{desktopThumbnails.ocrRows(it).size},cacheLive,
                                read={id,index->val photo=desktopThumbnails.ocrRows(id).getOrNull(index);val owned=photo?.takeIf{!it.isRecycled}?.copy(android.graphics.Bitmap.Config.ARGB_8888,false);if(owned==null)null else LocalOcr.readOwned(owned)},
                                project={id,texts->GeckoHost.background.ocrFields(id,texts,true)},now={android.os.SystemClock.elapsedRealtime()},snapshot={if(reviewBusy)saveOcr(it.copy(reason="INTERRUPTED",selected=selectedOcr))})
                            if(cached.summary.reason!="DONE"||!cacheLive())throw IllegalStateException("OCR_CACHE_CONTEXT")
                            cachedOcr.putAll(cached.rows.filterValues{ReviewDataSummary.fields(it)>0});pendingOcr.putAll(cachedOcr)
                            ocrImages=cached.summary.images;cachedImages=cached.summary.images;ocrTexts=cached.summary.texts;ocrErrors=cached.summary.errors;ocrProgress("INTERRUPTED")
                        }
                        // Large feed crops have been consumed; keep small visible thumbnails only.
                        if(withOcr)desktopThumbnails.clearOcr()
                        // Cached OCR never short-circuits the consented detail-opening stage.
                        var archiveRows=snapshot
                        ReviewDataRunner.run(geckoView,original,snapshot,true,alive={reviewBusy&&session===original&&desktopRows===snapshot&&lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)&&geckoView.isAttachedToWindow},progress={index,total->reviewPosition=index;reviewTotal=total;render()},restoreActive={session===original&&lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)},snapshot={if(reviewBusy)saveReviewResult(it.copy(reason="INTERRUPTED"))},originalChannel=cachedChannel,selectedPostId=selectedPostId,onValidatedRows={validated->archiveRows=validated;saveResult(validated,retainedOcr(pendingOcr))},onBoundPost={source,row,current,live->
                            if(withOcr&&ocrImages<20&&live()){
                                val crops=DesktopThumbnails()
                                try{
                                    val imageSafe=source.reviewImages(row,current,geckoView,crops,true,alive=live)
                                    imageChecks=ReviewImageChecks.add(imageChecks,source.reviewImageOutcome,source.reviewImageFilters);if(selectedPostId!=null)savePhotoDiagnosis(selectedPostId,source.reviewImageOutcome,source.reviewImageDetails,imageChecks);ocrProgress("INTERRUPTED")
                                    if(!imageSafe)throw IllegalStateException("OCR_CONTEXT")
                                    if(!live())throw IllegalStateException("OCR_CONTEXT")
                                    val photo=crops.ocrRows(row.postId).firstOrNull()
                                    if(photo!=null){
                                        if(!persistPhotos(archiveRows.map{if(it.postId==row.postId)row else it},retainedOcr(pendingOcr),crops))throw IllegalStateException("PHOTO_SAVE")
                                        desktopThumbnails.replacePostFrom(row.postId,crops)
                                        if(!live())throw IllegalStateException("OCR_CONTEXT")
                                        ocrImages++;ocrProgress("INTERRUPTED")
                                        val owned=photo.copy(android.graphics.Bitmap.Config.ARGB_8888,false)
                                        val recognized=try{kotlinx.coroutines.withTimeoutOrNull(8000){LocalOcr.readOwned(owned)}?:run{ocrErrors++;""}}catch(e:kotlinx.coroutines.CancellationException){throw e}catch(_:Exception){ocrErrors++;""}
                                        if(!live())throw IllegalStateException("OCR_CONTEXT")
                                        if(recognized.isNotBlank()){
                                            ocrTexts++;val suggestion=GeckoHost.background.ocrFields(row.postId,listOf(recognized),true)?:throw IllegalStateException("OCR_PROTOCOL")
                                            if(!live()||suggestion.postId!=row.postId||suggestion.permalink!=row.permalink)throw IllegalStateException("OCR_CONTEXT")
                                            if(ReviewDataSummary.fields(suggestion)>0)pendingOcr[row.postId]=suggestion
                                        }
                                        ocrProgress("INTERRUPTED")
                                        saveResult(archiveRows.map{if(it.postId==row.postId)row else it},retainedOcr(pendingOcr))
                                    }
                                }finally{crops.clear()}
                            }
                        })
                        }
                        if(!reviewBusy)return@launch
                        reviewBusy=false;reviewJob=null;saveReviewResult(outcome.summary);reviewReportPending=true
                        if(outcome.summary.reason=="DONE"){
                            ocrResults.putAll(previousOcr)
                            if(withOcr){ocrResults.putAll(pendingOcr);ocrProgress("DONE",completed=outcome.summary);ocrReportPending=true};desktopRows=outcome.rows.take(20);desktopThumbnails.retain(desktopRows.map{it.postId}.toSet())
                            offersPanel.showRows(desktopRows,"Uzupełniono: ${outcome.summary.enriched} • bez potwierdzonego odczytu: ${outcome.summary.unresolved}",thumbnails=::offerPictures)
                            saveResult()
                            output.text=outcome.summary.report();selectContentTab(true);render()
                        }else{
                            val keep=outcome.summary.reason=="NO_OWN_POST"&&session===original&&desktopRows===snapshot&&haltMessage==null&&kind==PageKind.APPROVED_GROUP&&lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)
                            if(withOcr){pendingOcr.clear();if(keep)pendingOcr.putAll(cachedOcr);ocrProgress(if(keep&&cachedImages>0)"PARTIAL" else "CONTEXT",outcome.summary);ocrReportPending=true}
                            publishReviewFailure(outcome.summary,preservePreview=keep)
                            if(withOcr&&keep){
                                ocrResults.putAll(previousOcr);ocrResults.putAll(cachedOcr);saveResult()
                                offersPanel.showRows(desktopRows,"OCR z pamięci ukończony; otwieranie zatrzymane. Dotychczasowe wyniki pozostają dostępne.",thumbnails=::offerPictures)
                                selectContentTab(true)
                            }
                            output.text=outcome.summary.report();render()
                        }
                    }catch(_:kotlinx.coroutines.TimeoutCancellationException){if(reviewBusy)cancelReview("DEADLINE")}
                    catch(e:kotlinx.coroutines.CancellationException){throw e}
                    catch(_:Exception){if(reviewBusy)cancelReview("ERROR")}
                    finally{reviewClosing=false;reviewOcrActive=false;if(!reviewBusy)reviewJob=null;render();if(selectedPostId!=null){ocrReportPending=false;if(lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED))showPhotoDiagnosis()} else if(withOcr)showPendingOcrReport() else showPendingReviewReport()}
                }

        }
        if(preconsented){start();return}
        reviewConsentDialog=AlertDialog.Builder(this).setTitle(if(selectedPostId!=null)"Sprawdź zdjęcie jednego posta" else if(withOcr)"Otwórz posty + OCR — nowa zgoda" else "Uzupełnij dane — nowa zgoda")
            .setMessage((if(selectedPostId!=null)"Tylko wybrany post: $selectedPostId. Diagnostyka dostępnych obrazów i przyczyn ich odrzucenia. Bez zmiany filtrów bezpieczeństwa.\n\n" else "")+(if(withOcr)"Dwa etapy w jednej próbie: najpierw OCR dostępnych zdjęć z pamięci, następnie otwieranie ${queue.size} postów do sprawdzenia i odczyt treści oraz jednego widocznego zdjęcia potwierdzonego posta. Łącznie do 20 obrazów i 3 minut na oba etapy. Sugestie osobno, DO SPRAWDZENIA, bez nadpisywania pól. Brak powiązania posta zatrzymuje otwieranie; ukończone wyniki OCR z pamięci mogą pozostać tylko przy zachowanej pierwotnej sesji.\n\n" else "")+"Otworzyć kolejno ${queue.size} dokładnych linków z Do ręcznego sprawdzenia? Jedna zatwierdzona grupa, do 20 postów i 3 minut. Każdy post ma osobną sesję roboczą, zamykaną przed otwarciem następnego. Cała kolejka korzysta z tej samej jednorazowej zgody i pozostałego czasu. Odczyt DOM i osadzonych danych; bez odczytu odpowiedzi sieciowych i bez klikania reakcji, komentarzy lub udostępniania.\n\nBez dodatkowego pobierania mediów, uploadu, skanu i kolektora. Tylko potwierdzone ID; pola heurystyczne. Komentarze, cytaty i cudze posty są wykluczone. Wyniki, zdjęcia i sugestie OCR zapisują się lokalnie do użycia przy kolejnym uruchomieniu. Logowanie/CAPTCHA/CHECKPOINT, zmiana kontekstu, pauza lub wygaszenie: STOP odczytu. Zachowany wynik pozostaje w bazie. Nowa jednorazowa zgoda; wcześniejsza zgoda na skan nie jest używana.")
            .setNegativeButton("Anuluj",null).setPositiveButton("Zgadzam się"){_,_->start()}
            .create().also{it.setCanceledOnTouchOutside(false);it.show()}
    }

    private fun openOffer(row:DesktopRow){
        if(desktopRows.isEmpty()&&savedResult?.rows?.any{it===row}==true){
            if(busyForTabs()||!lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED))return
            val link=OfferLinks.validated(row)?:OfferLinks.validatedReview(row)?:return
            val intent=Intent(Intent.ACTION_VIEW,Uri.parse(link)).addCategory(Intent.CATEGORY_BROWSABLE)
            if(runCatching{startActivity(intent)}.isFailure)output.text="Nie udało się otworzyć posta. Zachowany wynik pozostaje w bazie."
            return
        }
        if(!lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)||busyForTabs()||desktopRows.none{it===row})return
        val link=OfferLinks.validated(row)?:OfferLinks.validatedReview(row)?:return
        if(DesktopPresentation.reviewable(row)){
            val browser=session?:return
            // Explicit view-only navigation uses the already authenticated visible session.
            // No enrichment/OCR/scan is implicitly granted by opening a post.
            clearDesktopDetails();selectContentTab(false);geckoView.requestFocus()
            browser.loadUri(link);return
        }
        // Explicit user click; clear both UI copies/listeners before leaving the local preview.
        clearDesktopDetails()
        val intent=Intent(Intent.ACTION_VIEW,Uri.parse(link)).addCategory(Intent.CATEGORY_BROWSABLE)
        if(runCatching{startActivity(intent)}.isFailure)offersPanel.showRows(emptyList(),"Nie udało się otworzyć posta. Sprawdź dostępność Facebooka lub przeglądarki.")
    }
    private fun showDesktopResult(value:DesktopSummary?=DesktopSummary.decode(desktopPrefs.getString("last",null))){
        desktopResultDialog?.dismiss();desktopResultText?.text="";desktopResultText=null
        val report=value?.report()?:"Brak zakończonej próby komputerowej. Dotychczasowe raporty linków pozostają w archiwum."
        val preview=DesktopPresentation.preview(report,desktopRows,value!=null)
        val text=TextView(this).apply{text=preview;textSize=14f;setPadding(20,12,20,12)}
        desktopResultText=text
        desktopResultDialog=AlertDialog.Builder(this).setTitle("Wynik próby komputerowej").setView(ScrollView(this).apply{addView(text)})
            .setPositiveButton("Wróć do Facebooka",null)
            .setNeutralButton("Kopiuj raport (bez ID)"){_,_->getSystemService(android.content.ClipboardManager::class.java).setPrimaryClip(android.content.ClipData.newPlainText("Raport próby komputerowej",report))}.create()
        desktopResultDialog?.show()
    }

    private fun checkSharedLink() {
        if (shareBusy || responseBusy || visibleBusy || scanning || inspectingDom || measuringLoad || kind != PageKind.APPROVED_GROUP || channel?.isConnected != true || progress != 100) return
        val currentSession = session ?: return
        val currentChannel = channel ?: return
        val input = EditText(this).apply {
            hint = "https://www.facebook.com/share/p/…/"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            imeOptions = EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
            isSingleLine = true; isSaveEnabled = false
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        }
        shareDialog = AlertDialog.Builder(this).setTitle("Sprawdź jeden udostępniony link")
            .setMessage("NOWA JEDNORAZOWA ZGODA: otworzyć w tej sesji jeden wklejony link /share/p/ i sprawdzić jego przekierowanie? Do 20 s i 8 żądań nawigacji. Obejmuje adres poza stroną główną grupy, wyłącznie w celu rozpoznania dokładnego permalinku zatwierdzonej grupy. Bez odczytu treści postów, skryptów, odpowiedzi sieciowych, nagłówków i danych logowania. Kontrola bezpieczeństwa strony: tytuł, obecność formularzy weryfikacji i metadane świeżości dokumentu; czas nie jest zapisywany. Aplikacja zapisze lokalnie wyłącznie status, powód i liczniki ostatniej zakończonej próby, aby wynik nie zniknął po powrocie do grupy lub zamknięciu aplikacji. Nie zapisuje linku, ID ani treści posta i niczego nie wysyła. Przeglądarka korzysta z istniejącego profilu jak przy ręcznym otwarciu. Bez kolektora. Raport zawiera status i liczby, nie adres ani ID. Logowanie/CAPTCHA/CHECKPOINT, inna grupa, utrata kontekstu lub wygaszenie: STOP. Jeśli Facebook zmieni dozwolony adres bez żądania nawigacji, aplikacja może raz otworzyć ten adres ponownie w tym samym limicie 20 s i 8 żądań. Taki wynik sprawdza adres, ale nie dowodzi powiązania z linkiem udostępnienia ani istnienia oferty. Zgoda nie uruchamia skanu.")
            .setView(input).setNegativeButton("Anuluj", null)
            .setPositiveButton("Zgadzam się — sprawdź") { _, _ ->
                val raw = input.text.toString().trim(); input.text.clear()
                if (!lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED) || session !== currentSession || channel !== currentChannel || kind != PageKind.APPROVED_GROUP || shareBusy || responseBusy || scanning) return@setPositiveButton
                val resolver = ShareLinkResolver(now = { android.os.SystemClock.elapsedRealtime() }, allowAddressReload = true)
                if (!resolver.begin(raw, true, url)) { ShareLinkResult.snapshot(resolver)?.let { publishShareResult(it, true) }; return@setPositiveButton }
                stopVisiblePosts(); shareResolver = resolver; shareBusy = true
                sharePageLoading = false
                resolver.waitingFor(ShareLinkWait.LOCATION)
                sharePortAfterGeneration = currentChannel.connectionGeneration
                shareDocumentAfter = System.currentTimeMillis()
                output.text = "LINK 0.4.4: sprawdzanie przekierowania, maksymalnie 20 s."; render()
                currentSession.loadUri(raw)
                shareJob = lifecycleScope.launch {
                    while (shareBusy && shareResolver === resolver && resolver.tick()) {
                        val expected = url
                        when {
                            resolver.pendingAddressReload != null -> resolver.waitingFor(ShareLinkWait.SOURCE_LOADING)
                            expected == null || !resolver.canInspect(expected) -> resolver.waitingFor(ShareLinkWait.LOCATION)
                            !currentChannel.isConnected -> resolver.waitingFor(ShareLinkWait.PORT)
                            currentChannel.connectionGeneration <= sharePortAfterGeneration -> resolver.waitingFor(ShareLinkWait.NEW_PORT)
                            currentChannel.connectedUrl != expected -> resolver.waitingFor(ShareLinkWait.PORT_ADDRESS)
                            else -> {
                                resolver.waitingFor(ShareLinkWait.CONTEXT_REPLY)
                                val context = currentChannel.shareLinkProof(expected, true, shareDocumentAfter)
                                if (shareResolver !== resolver || !shareBusy) return@launch
                                if (url == expected) when(context) {
                                    ShareContextReply.ABSENT -> resolver.waitingFor(ShareLinkWait.CONTEXT_REPLY)
                                    ShareContextReply.MALFORMED -> resolver.waitingFor(ShareLinkWait.CONTEXT_PROTOCOL)
                                    ShareContextReply.STALE -> resolver.waitingFor(ShareLinkWait.DOCUMENT_FRESHNESS)
                                    ShareContextReply.UNSAFE -> resolver.confirm(expected, false, false)
                                    ShareContextReply.LOADING -> {
                                        resolver.waitingFor(ShareLinkWait.DOCUMENT_COMPLETE)
                                        resolver.confirm(expected, true, false)
                                    }
                                    ShareContextReply.COMPLETE -> {
                                        if (!resolver.hasExactPostAddress) resolver.waitingFor(ShareLinkWait.EXACT_PERMALINK)
                                        else if (progress != 100) resolver.waitingFor(ShareLinkWait.NATIVE_PROGRESS)
                                        resolver.confirm(expected, true, progress == 100)
                                    }
                                }
                                if (!resolver.active) break
                            }
                        }
                        delay(200)
                    }
                    if (shareResolver === resolver && shareBusy) finishShare()
                }
            }.create()
        shareDialog?.setOnDismissListener { input.text.clear(); shareDialog = null }
        shareDialog?.show()
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

    private fun checkMainTransport() {
        if (responseBusy || visibleBusy || scanning || inspectingDom || measuringLoad || kind != PageKind.APPROVED_GROUP || progress < 100 || haltMessage != null) return
        val current=channel ?: return
        val epoch=visibleEpoch
        val approvedUrl=url
        visibleDialog=AlertDialog.Builder(this).setTitle("Nowa zgoda: mechanizm rozszerzenia")
            .setMessage("Jednorazowo uruchomić mechanizm fetch/XHR z rozszerzenia komputerowego na BIEŻĄCEJ zatwierdzonej grupie? Okno do 20 s, bez ponownego otwierania. Obejmuje nowe odpowiedzi powstałe po tej zgodzie i do 5 automatycznych przewinięć po 400–900 px (łącznie do 4500 px), z adaptacyjnym czekaniem na zmianę feedu. Do 8 odpowiedzi, 512 KiB/odpowiedź, 2 MiB łącznie i 20 dokładnych ID. Odpowiedzi dla strony pozostają niezmienione. Treści przejściowo tylko w RAM rozszerzenia; wynik to wyłącznie liczniki. Bez odczytu Beacon, nagłówków i wysyłanych payloadów; bez wyodrębniania cookies/tokenów; bez zapisu treści/ID, uploadu, skanu i kolektora. LOGIN/CAPTCHA/CHECKPOINT, zmiana strony, utrata portu lub wygaszenie: STOP i czyszczenie. Ta nowa zgoda nie wykorzystuje poprzednich zgód i wygasa po próbie.")
            .setNegativeButton("Anuluj",null).setPositiveButton("Zgadzam się jednorazowo") { _, _ ->
                if (epoch!=visibleEpoch || current!==channel || approvedUrl!=url || kind!=PageKind.APPROVED_GROUP) return@setPositiveButton
                responseBusy=true;output.text="Mechanizm rozszerzenia: do 20 s i 5 przewinięć. Zmiana kontekstu lub wygaszenie: STOP.";render()
                lifecycleScope.launch {
                    val report=runCatching { current.mainTransport(consent=true,autoScrollConsent=true) }.getOrNull()
                    if(epoch==visibleEpoch && current===channel && approvedUrl==url && kind==PageKind.APPROVED_GROUP) {
                        responseBusy=false;output.text=report ?: "STOP: przerwana próba mechanizmu rozszerzenia.";render()
                    }
                }
            }.show()
    }

    private fun checkResponses(autoScroll: Boolean = false) {
        val fast = autoScroll && fastScrollOption.isChecked
        if (responseBusy || visibleBusy || scanning || inspectingDom || measuringLoad || kind != PageKind.APPROVED_GROUP || progress < 100 || haltMessage != null) return
        val current = channel ?: return
        val epoch = visibleEpoch
        val approvedUrl = url
        visibleDialog = AlertDialog.Builder(this)
            .setTitle(if (autoScroll) "Nowa zgoda: odpowiedzi i przewijanie" else "Nowa zgoda: treść odpowiedzi sieciowych")
            .setMessage((if (autoScroll) "ZEZWOLIĆ NA AUTOMATYCZNE PRZEWIJANIE? Maksymalnie 5 kroków po 400–900 px, pierwszy po ${if (fast) "0,25 s" else "1 s"}, następne co ${if (fast) "0,5 s" else "2 s"}; łącznie do 4500 px. Tylko okno diagnostyki 15 s, bez klikania, skanu i kolektora. " else "Bez automatycznego przewijania. ") + "Przez 15 sekund analizować lokalnie odpowiedzi danych tej zatwierdzonej grupy? Dodatkowo policzyć zdarzenia Facebook/CDN i powody pominięcia (karta, ramka, typ, host, ścieżka, kontekst), także zbiorczo ruch bez karty lub innej karty, bez jego treści i adresów? Do 8 odpowiedzi, 512 KiB na odpowiedź i 2 MiB łącznie, maksymalnie 20 dokładnych ID. Tylko pamięć i liczniki: bez zapisu surowych odpowiedzi, tekstów, ID, cookies i tokenów; bez uploadu, skanu, galerii i kolektora. Strona otrzyma niezmienione bajty. Możesz ręcznie przewinąć grupę. Zmiana strony, LOGIN/CAPTCHA/CHECKPOINT i wygaszenie przerywają próbę. To osobna zgoda, niezależna od DOM i starego skanu.")
            .setNegativeButton("Anuluj", null)
            .setPositiveButton("Zgadzam się jednorazowo") { _, _ ->
                if (epoch != visibleEpoch || current !== channel || approvedUrl != url || kind != PageKind.APPROVED_GROUP) return@setPositiveButton
                responseBusy = true
                output.text = if (autoScroll) "Diagnostyka: 15 sekund, do 5 automatycznych przewinięć. Zmiana kontekstu lub wygaszenie: STOP." else "Diagnostyka odpowiedzi: 15 sekund. Możesz ręcznie przewinąć zatwierdzoną grupę."
                render()
                lifecycleScope.launch {
                    val report = runCatching { current.responseDiagnosis(consent = true, autoScrollConsent = autoScroll, fastScrollConsent = fast) }.getOrNull()
                    if (epoch == visibleEpoch && current === channel && approvedUrl == url && kind == PageKind.APPROVED_GROUP) {
                        output.text = report ?: "STOP: przerwana diagnostyka odpowiedzi."
                        responseBusy = false
                        render()
                    }
                }
            }.show()
    }

    private fun checkResponseLoad(autoScroll: Boolean = false, document: Boolean = false) {
        val fast = autoScroll && fastScrollOption.isChecked
        if (responseBusy || visibleBusy || scanning || inspectingDom || measuringLoad || kind != PageKind.APPROVED_GROUP || progress < 100 || haltMessage != null) return
        val currentSession = session ?: return
        val current = channel ?: return
        val approvedUrl = url ?: return
        val epoch = visibleEpoch
        visibleDialog = AlertDialog.Builder(this).setTitle(if (document) "Nowa zgoda: dokument grupy" else if (autoScroll) "Nowa zgoda: otwarcie + przewijanie" else "Nowa zgoda: jedno otwarcie i odpowiedzi")
            .setMessage(if (document) "Jednorazowo ponownie otworzyć DOKŁADNIE tę zatwierdzoną grupę i odczytać wyłącznie jej dokument HTML (do 2 MiB, okno 25 s)? Lokalna analiza dokładnych linków i osadzonych bloków application/json oraz literałów JSON w dokładnych opakowaniach require(„ServerJS”).handle(...) i new ServerJS().handle(...). Maksymalnie 64 skrypty po 512 KiB i 20 ID. Inne opakowania są pomijane. Kod skryptów nie jest wykonywany przez parser. Bez odczytu XHR, Beacon, innych odpowiedzi, nagłówków ani pól logowania; bez wyodrębniania cookies/tokenów. HTML i JSON tylko przejściowo w ograniczonym RAM, usuwane po próbie. Na wyjściu tylko liczniki, bez treści, ID i adresów. Bez zapisu, uploadu, przewijania, skanu i kolektora. Nowa jednorazowa zgoda niezależna od poprzednich. Zmiana strony, logowanie, CAPTCHA, CHECKPOINT lub wygaszenie: STOP. Anulowanie niczego nie odczytuje." else (if (autoScroll) "ZEZWOLIĆ TAKŻE NA AUTOMATYCZNE PRZEWIJANIE? Do 5 kroków po 400–900 px, maksymalnie 4500 px. Pierwszy po sprawdzeniu nowego dokumentu i ${if (fast) "0,25 s" else "1 s"}, kolejne co ${if (fast) "0,5 s" else "2 s"}. Przeładowanie i przewijanie dzielą JEDNO okno do 25 s; wolne ładowanie zmniejsza liczbę kroków. " else "Bez automatycznego przewijania. ") + "Otworzyć ponownie DOKŁADNIE tę zatwierdzoną grupę w tej samej karcie i przez 25 s odczytywać lokalnie jej odpowiedzi danych? Obejmuje typy XHR, fetch i other, wyłącznie dozwolone endpointy, top-frame i dokładny kontekst grupy. Osobno policzyć dokładne typy zasobów (w tym ping/beacon), klasy /ajax/bz, inne /ajax i /data oraz zgodność ramki/origin? To wyłącznie liczniki metadanych, bez odczytu treści dodatkowych typów. To nowy zakres, niezależny od skanu i przewijania. Do 8 odpowiedzi, 512 KiB na odpowiedź, 2 MiB łącznie i 20 ID. Wcześniejsze odpowiedzi pozostaną w ograniczonej pamięci RAM do sprawdzenia nowego dokumentu; bez potwierdzenia zostaną usunięte bez analizy postów. Bez odczytu dokumentu HTML, nagłówków, cookies i tokenów, zapisu, uploadu, skanu i kolektora. Tylko jedno zatwierdzone otwarcie; kolejne przejście, LOGIN/CAPTCHA/CHECKPOINT, pauza, wygaszenie lub utrata kontekstu: STOP.")
            .setNegativeButton("Anuluj", null).setPositiveButton("Zgadzam się jednorazowo") { _, _ ->
                if (epoch != visibleEpoch || current !== channel || currentSession !== session || approvedUrl != url || kind != PageKind.APPROVED_GROUP) return@setPositiveButton
                responseReloadGate.begin(approvedUrl); responseBusy = true
                output.text = "Diagnostyka od otwarcia: 25 s, jedno zatwierdzone otwarcie. Nie dotykaj ekranu."
                render()
                lifecycleScope.launch {
                    val report = runCatching { ResponseLoadRunner(GeckoHost.background).run(currentSession, current, approvedUrl,
                        PocPolicy.APPROVED_GROUP_ID, autoScrollConsent = autoScroll, fastScrollConsent = fast, documentConsent = document, alive = { epoch == visibleEpoch && currentSession === session && responseReloadGate.active },
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

    private fun groupPreference(base:String)=if(PocPolicy.APPROVED_GROUP_ID==WatcherGroups.LEGACY_GROUP)base else base+"_"+PocPolicy.APPROVED_GROUP_ID

    private fun chooseWatcherGroup(){
        if(busyForTabs()||deletingResults||archiveWritePending)return
        val groups=WatcherGroups.configured
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
        buttons["tools"]?.isEnabled = !reviewWorking() && !desktopBusy && !shareBusy && !responseBusy && !visibleBusy && !scanning && !inspectingDom && !measuringLoad
        if(::offersTab.isInitialized){
            val enabled=!busyForTabs()
            facebookTab.isEnabled=enabled;offersTab.isEnabled=enabled
            offersTab.text="Oferty (${displayedRows().count{DesktopSummary.eligible(it)}})"
        }
        listOf("desktopResult","reviewResult","ocrResult","deleteResults","savedOcr","photoDiagnosis","watcherGroups").forEach{buttons[it]?.isEnabled=!busyForTabs()}
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
            setPadding((12 * dp).toInt(), (8 * dp).toInt(), (12 * dp).toInt(), (8 * dp).toInt())
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
            addView(row(button("desktopPreview","Automatyczny podgląd • 30 s"){startDesktopPreview()}))
            addView(row(button("desktopResult","Oferty"){selectContentTab(true)}))
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
