package pl.jakubokruszek.flipcollector.watcher.android

import android.content.Context
import pl.jakubokruszek.flipcollector.watcher.GroupSelection
import pl.jakubokruszek.flipcollector.watcher.ScanRecord
import pl.jakubokruszek.flipcollector.watcher.ScanSchedule
import pl.jakubokruszek.flipcollector.watcher.WatchedGroup
import pl.jakubokruszek.flipcollector.watcher.WatcherCodec

/**
 * Local, free persistence of the watcher's settings, groups and history in
 * private SharedPreferences. No token, cookie or Facebook session is stored
 * here; the device token lives in DeviceTokenStore (Keystore-encrypted).
 */
class WatcherSettingsStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun schedule(): ScanSchedule = WatcherCodec.decodeSchedule(preferences.getString(KEY_SCHEDULE, null))
    fun saveSchedule(schedule: ScanSchedule) = preferences.edit().putString(KEY_SCHEDULE, WatcherCodec.encodeSchedule(schedule)).apply()

    fun groups(): List<WatchedGroup> = WatcherCodec.decodeGroups(preferences.getString(KEY_GROUPS, null))
    fun saveGroups(groups: List<WatchedGroup>) = preferences.edit().putString(KEY_GROUPS, WatcherCodec.encodeGroups(groups)).apply()

    fun selection(): GroupSelection = WatcherCodec.decodeSelection(preferences.getString(KEY_SELECTION, null))
    fun saveSelection(selection: GroupSelection) = preferences.edit().putString(KEY_SELECTION, WatcherCodec.encodeSelection(selection)).apply()

    fun history(): List<ScanRecord> = WatcherCodec.decodeHistory(preferences.getString(KEY_HISTORY, null))

    @Synchronized
    fun appendHistory(record: ScanRecord) {
        val updated = WatcherCodec.prepend(history(), record)
        preferences.edit().putString(KEY_HISTORY, WatcherCodec.encodeHistory(updated)).commit()
    }

    fun clearHistory() = preferences.edit().remove(KEY_HISTORY).apply()

    fun lastStartedWindowKey(): String? = preferences.getString(KEY_LAST_WINDOW, null)
    fun saveLastStartedWindowKey(key: String) = preferences.edit().putString(KEY_LAST_WINDOW, key).commit()

    /** Last automatic check, shown on the screen ("Ostatnia kontrola automatu"). */
    fun lastAutoCheck(): String? = preferences.getString(KEY_LAST_AUTO_CHECK, null)
    fun saveLastAutoCheck(text: String) = preferences.edit().putString(KEY_LAST_AUTO_CHECK, text).apply()

    /** Separate consent to keep a Facebook session on the phone. Not settable in this release. */
    fun facebookSessionConsent(): Boolean = preferences.getBoolean(KEY_FACEBOOK_CONSENT, false)

    companion object {
        private const val FILE = "flip_collector_watcher"
        private const val KEY_SCHEDULE = "schedule"
        private const val KEY_GROUPS = "groups"
        private const val KEY_SELECTION = "selection"
        private const val KEY_HISTORY = "history"
        private const val KEY_LAST_WINDOW = "last_started_window"
        private const val KEY_LAST_AUTO_CHECK = "last_auto_check"
        private const val KEY_FACEBOOK_CONSENT = "facebook_session_consent"
    }
}
