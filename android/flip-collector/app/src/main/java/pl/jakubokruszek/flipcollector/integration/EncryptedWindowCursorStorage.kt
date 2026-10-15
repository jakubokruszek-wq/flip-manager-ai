package pl.jakubokruszek.flipcollector.integration

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONObject

class EncryptedWindowCursorStorage(context: Context) : WindowCursorStorage {
    private val prefs=EncryptedSharedPreferences.create(context,"flip_android_window_cursor",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
    override fun load(windowKey: String, mode: String): WindowCursor? = synchronized(lock) {
        require(mode in setOf("DEMO","LIVE"))
        val raw=prefs.getString(mode,null) ?: return@synchronized null
        val row=JSONObject(raw)
        check(row.getString("mode")==mode) { "Cursor domain mismatch" }
        if(row.getString("windowKey")!=windowKey) return@synchronized null
        fun strings(key: String): List<String> { val array=row.getJSONArray(key);return (0 until array.length()).map { array.getString(it) } }
        WindowCursor(windowKey,mode,strings("pending"),strings("finished").toSet())
    }
    override fun save(cursor: WindowCursor) = synchronized(lock) {
        require(cursor.mode in setOf("DEMO","LIVE"))
        val old=load(cursor.windowKey,cursor.mode)
        check(old==null||cursor.finished.containsAll(old.finished)) { "Refusing to lose completed sources" }
        val raw=JSONObject().put("mode",cursor.mode).put("windowKey",cursor.windowKey)
            .put("pending",JSONArray(cursor.pending)).put("finished",JSONArray(cursor.finished.toList())).toString()
        check(prefs.edit().putString(cursor.mode,raw).commit()) { "Window cursor persistence failed" }
    }
    companion object { private val lock=Any() }
}
