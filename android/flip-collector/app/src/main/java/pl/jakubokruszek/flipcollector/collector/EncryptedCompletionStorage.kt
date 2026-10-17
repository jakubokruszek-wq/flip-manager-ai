package pl.jakubokruszek.flipcollector.collector

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONObject

class EncryptedCompletionStorage(context: Context) : CompletionStorage {
    private val prefs = EncryptedSharedPreferences.create(context, "flip_android_completion_outbox",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
    override fun load(): PendingCompletion? = prefs.getString("pending", null)?.let {
        // Corrupt storage must fail closed, not silently drop an in-flight import.
        val row = JSONObject(it)
        PendingCompletion(row.getString("deviceId"), row.getString("jobId"), row.getString("leaseToken"), row.getString("completionId"), row.getString("rawBody"))
    }
    override fun save(value: PendingCompletion?) {
        val edit = prefs.edit()
        if (value == null) edit.remove("pending") else edit.putString("pending", JSONObject()
            .put("deviceId", value.deviceId).put("jobId", value.jobId).put("leaseToken", value.leaseToken)
            .put("completionId", value.completionId).put("rawBody", value.rawBody).toString())
        check(edit.commit()) { "Outbox persistence failed" }
    }
}
