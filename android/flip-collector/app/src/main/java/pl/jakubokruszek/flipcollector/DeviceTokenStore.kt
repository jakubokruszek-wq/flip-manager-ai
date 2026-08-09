package pl.jakubokruszek.flipcollector

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class DeviceTokenStore(context: Context) {
    private val preferences = EncryptedSharedPreferences.create(
        context,
        "flip_collector_secure",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun token(): String? = preferences.getString(KEY_TOKEN, null)

    fun saveToken(value: String) {
        preferences.edit().putString(KEY_TOKEN, value).apply()
    }

    fun clearToken() {
        preferences.edit().remove(KEY_TOKEN).apply()
    }

    companion object {
        private const val KEY_TOKEN = "device_token"
    }
}
