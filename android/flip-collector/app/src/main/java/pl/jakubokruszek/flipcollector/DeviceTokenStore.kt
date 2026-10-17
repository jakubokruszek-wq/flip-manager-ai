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

    /** Collector device id; signed requests (HMAC) need it beside the token. */
    fun deviceId(): String? = preferences.getString(KEY_DEVICE_ID, null)?.takeIf { it.isNotBlank() && it != MANUAL_DEVICE_ID }

    fun saveToken(value: String, deviceId: String? = null) {
        preferences.edit().putString(KEY_TOKEN, value).putString(KEY_DEVICE_ID, deviceId).apply()
    }

    fun clearToken() {
        preferences.edit().remove(KEY_TOKEN).remove(KEY_DEVICE_ID).apply()
    }

    companion object {
        private const val KEY_TOKEN = "device_token"
        private const val KEY_DEVICE_ID = "device_id"
        const val MANUAL_DEVICE_ID = "manual"
    }
}
