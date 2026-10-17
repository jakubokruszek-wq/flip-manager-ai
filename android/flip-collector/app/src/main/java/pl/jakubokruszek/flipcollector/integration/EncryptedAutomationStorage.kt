package pl.jakubokruszek.flipcollector.integration

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class EncryptedAutomationStorage(context: Context, namespace: String) : AtomicAutomationStorage {
    init { require(Regex("^[a-f0-9]{64}$").matches(namespace)) }
    private val prefs=EncryptedSharedPreferences.create(context,"flip_offline_automation_"+namespace,
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
    override fun read(): String? = prefs.getString("state",null)
    override fun write(value: String) { check(prefs.edit().putString("state",value).commit()) { "AUTOMATION_PERSISTENCE_FAILED" } }
}
