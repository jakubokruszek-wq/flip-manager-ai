package pl.jakubokruszek.flipcollector.watcher.android

import android.content.Context
import pl.jakubokruszek.flipcollector.integration.SyncedGroup
import pl.jakubokruszek.flipcollector.watcher.DiagnosticEvent
import pl.jakubokruszek.flipcollector.watcher.DiagnosticLevel
import pl.jakubokruszek.flipcollector.watcher.Diagnostics
import pl.jakubokruszek.flipcollector.watcher.GroupSelection
import pl.jakubokruszek.flipcollector.watcher.ScanJournal
import pl.jakubokruszek.flipcollector.watcher.ScanMode
import pl.jakubokruszek.flipcollector.watcher.ScanOutcome
import pl.jakubokruszek.flipcollector.watcher.ScanRecord
import pl.jakubokruszek.flipcollector.watcher.ScanRecovery
import pl.jakubokruszek.flipcollector.watcher.ScanSchedule
import pl.jakubokruszek.flipcollector.watcher.WatchedGroup
import pl.jakubokruszek.flipcollector.watcher.WatcherCodec
import pl.jakubokruszek.flipcollector.watcher.WindowEntry
import pl.jakubokruszek.flipcollector.watcher.WindowLedger
import java.time.Instant

/**
 * Local, free persistence of the watcher in private SharedPreferences: settings,
 * groups, history (separately for demo and live scans), the active scan journal,
 * the window ledger and diagnostics. No token, cookie or Facebook session is
 * stored here; the device token lives in DeviceTokenStore (Keystore-encrypted).
 *
 * Writes that recovery depends on (journal, ledger, history) use commit(), so
 * they are on disk before the next step runs.
 */
class WatcherSettingsStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    init {
        migrateLegacyHistory()
    }

    fun schedule(): ScanSchedule = WatcherCodec.decodeSchedule(preferences.getString(KEY_SCHEDULE, null))
    fun saveSchedule(schedule: ScanSchedule) = preferences.edit().putString(KEY_SCHEDULE, WatcherCodec.encodeSchedule(schedule)).apply()

    // ---- groups

    fun syncedGroups(): List<SyncedGroup> = WatcherCodec.decodeSyncedGroups(preferences.getString(KEY_GROUPS, null))
    fun saveSyncedGroups(groups: List<SyncedGroup>) = preferences.edit().putString(KEY_GROUPS, WatcherCodec.encodeSyncedGroups(groups)).apply()

    /** Groups as the scanner sees them: active only when both the phone and Flip Manager allow it. */
    fun groups(): List<WatchedGroup> = syncedGroups().map { it.group.copy(active = it.scannable) }

    fun selection(): GroupSelection = WatcherCodec.decodeSelection(preferences.getString(KEY_SELECTION, null))
    fun saveSelection(selection: GroupSelection) = preferences.edit().putString(KEY_SELECTION, WatcherCodec.encodeSelection(selection)).apply()

    fun lastGroupSync(): String? = preferences.getString(KEY_LAST_GROUP_SYNC, null)
    fun saveLastGroupSync(text: String) = preferences.edit().putString(KEY_LAST_GROUP_SYNC, text).apply()

    // ---- history, kept apart per mode so demo runs never mix with real results

    fun history(mode: ScanMode): List<ScanRecord> = WatcherCodec.decodeHistory(preferences.getString(historyKey(mode), null))

    fun allHistory(): List<ScanRecord> = (history(ScanMode.LIVE) + history(ScanMode.DEMO)).sortedByDescending { it.startedAt }

    @Synchronized
    fun appendHistory(record: ScanRecord) {
        val updated = WatcherCodec.prepend(history(record.mode), record)
        preferences.edit().putString(historyKey(record.mode), WatcherCodec.encodeHistory(updated)).commit()
    }

    fun clearHistory(mode: ScanMode) = preferences.edit().remove(historyKey(mode)).apply()

    private fun historyKey(mode: ScanMode) = if (mode == ScanMode.LIVE) KEY_HISTORY_LIVE else KEY_HISTORY_DEMO

    /** 0.2–0.3 kept one history; every scan then was a demo or dry run, so it moves to the demo history. */
    @Synchronized
    private fun migrateLegacyHistory() {
        val legacy = preferences.getString(KEY_HISTORY_LEGACY, null) ?: return
        val records = WatcherCodec.decodeHistory(legacy).map { it.copy(mode = ScanMode.DEMO) }
        val merged = (records + history(ScanMode.DEMO)).distinctBy { it.id }.sortedByDescending { it.startedAt }.take(WatcherCodec.HISTORY_LIMIT)
        preferences.edit().putString(KEY_HISTORY_DEMO, WatcherCodec.encodeHistory(merged)).remove(KEY_HISTORY_LEGACY).commit()
    }

    // ---- active scan journal and window ledger

    fun journal(): ScanJournal? = ScanRecovery.decode(preferences.getString(KEY_JOURNAL, null))
    fun saveJournal(journal: ScanJournal) = preferences.edit().putString(KEY_JOURNAL, ScanRecovery.encode(journal)).commit()
    fun clearJournal() = preferences.edit().remove(KEY_JOURNAL).commit()

    fun ledger(): List<WindowEntry> = WindowLedger.decode(preferences.getString(KEY_LEDGER, null))

    @Synchronized
    fun markWindowStarted(key: String) {
        preferences.edit().putString(KEY_LEDGER, WindowLedger.encode(WindowLedger.started(ledger(), key, Instant.now()))).commit()
    }

    @Synchronized
    fun markWindowFinished(key: String, outcome: ScanOutcome) {
        preferences.edit().putString(KEY_LEDGER, WindowLedger.encode(WindowLedger.finished(ledger(), key, outcome, Instant.now()))).commit()
    }

    // ---- diagnostics

    fun diagnostics(): List<DiagnosticEvent> = Diagnostics.decode(preferences.getString(KEY_DIAGNOSTICS, null))

    @Synchronized
    fun log(level: DiagnosticLevel, code: String, message: String) {
        val updated = Diagnostics.append(diagnostics(), DiagnosticEvent(Instant.now().toString(), level, code, message))
        preferences.edit().putString(KEY_DIAGNOSTICS, Diagnostics.encode(updated)).commit()
    }

    fun clearDiagnostics() = preferences.edit().remove(KEY_DIAGNOSTICS).apply()

    /** Last automatic check, shown on the screen ("Ostatnia kontrola automatu"). */
    fun lastAutoCheck(): String? = preferences.getString(KEY_LAST_AUTO_CHECK, null)
    fun saveLastAutoCheck(text: String) = preferences.edit().putString(KEY_LAST_AUTO_CHECK, text).apply()

    /** Demo only: make the demo scan fail part-way, to see the error path on the phone. */
    fun demoSimulateError(): Boolean = preferences.getBoolean(KEY_DEMO_ERROR, false)
    fun saveDemoSimulateError(value: Boolean) = preferences.edit().putBoolean(KEY_DEMO_ERROR, value).apply()

    /** A summary notification after each scan (needs POST_NOTIFICATIONS on Android 13+). */
    fun notifyAfterScan(): Boolean = preferences.getBoolean(KEY_NOTIFY, true)
    fun saveNotifyAfterScan(value: Boolean) = preferences.edit().putBoolean(KEY_NOTIFY, value).apply()

    /** Separate consent to keep a Facebook session on the phone. Not settable in this release. */
    fun facebookSessionConsent(): Boolean = preferences.getBoolean(KEY_FACEBOOK_CONSENT, false)

    companion object {
        private const val FILE = "flip_collector_watcher"
        private const val KEY_SCHEDULE = "schedule"
        private const val KEY_GROUPS = "groups"
        private const val KEY_SELECTION = "selection"
        private const val KEY_LAST_GROUP_SYNC = "last_group_sync"
        private const val KEY_HISTORY_LEGACY = "history"
        private const val KEY_HISTORY_DEMO = "history_demo"
        private const val KEY_HISTORY_LIVE = "history_live"
        private const val KEY_JOURNAL = "active_scan_journal"
        private const val KEY_LEDGER = "window_ledger"
        private const val KEY_DIAGNOSTICS = "diagnostics"
        private const val KEY_LAST_AUTO_CHECK = "last_auto_check"
        private const val KEY_DEMO_ERROR = "demo_simulate_error"
        private const val KEY_NOTIFY = "notify_after_scan"
        private const val KEY_FACEBOOK_CONSENT = "facebook_session_consent"
    }
}
