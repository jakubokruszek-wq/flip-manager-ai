package pl.jakubokruszek.flipcollector

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class CollectorApi(private val baseUrl: String) {
    private val client = OkHttpClient.Builder()
        .callTimeout(30, TimeUnit.SECONDS)
        .build()

    fun registerDevice(pairingSecret: String, deviceName: String, installationId: String): String {
        val request = Request.Builder()
            .url(endpoint("/api/collector/devices/register"))
            .header("x-flip-collector-pairing-secret", pairingSecret)
            .post(
                JSONObject()
                    .put("deviceName", deviceName)
                    .put("installationId", installationId)
                    .toString()
                    .toRequestBody(JSON),
            )
            .build()

        return client.newCall(request).execute().use { response ->
            val body = response.body.string()
            if (!response.isSuccessful) throw IllegalStateException(message(body, "Nie udało się sparować urządzenia."))
            JSONObject(body).getString("deviceToken")
        }
    }

    fun importFacebook(token: String, draft: FacebookImportDraft) {
        val images = JSONArray().apply { draft.imageUrls.forEach(::put) }
        val request = Request.Builder()
            .url(endpoint("/api/collector/facebook/import"))
            .header("Authorization", "Bearer $token")
            .header("Idempotency-Key", draft.idempotencyKey)
            .post(
                JSONObject()
                    .put("sourcePostUrl", draft.sourcePostUrl)
                    .put("title", draft.title)
                    .put("groupName", draft.groupName)
                    .put("authorName", draft.authorName)
                    .put("publishedAt", draft.publishedAt)
                    .put("content", draft.content)
                    .put("price", draft.price.toDoubleOrNull())
                    .put("area", draft.area.replace(',', '.').toDoubleOrNull())
                    .put("rooms", draft.rooms.replace(',', '.').toDoubleOrNull())
                    .put("location", draft.location.ifBlank { null })
                    .put("imageUrls", images)
                    .put("collectedAt", draft.collectedAt)
                    .toString()
                    .toRequestBody(JSON),
            )
            .build()

        client.newCall(request).execute().use { response ->
            val body = response.body.string()
            if (!response.isSuccessful) throw IllegalStateException(message(body, "Nie udało się wysłać importu."))
        }
    }

    fun revokeDevice(token: String) {
        val request = Request.Builder()
            .url(endpoint("/api/collector/devices/current"))
            .header("Authorization", "Bearer $token")
            .delete()
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException("Nie udało się unieważnić tokenu.")
        }
    }

    fun currentDevice(token: String): JSONObject {
        val request = Request.Builder().url(endpoint("/api/collector/devices/current")).header("Authorization", "Bearer $token").get().build()
        return client.newCall(request).execute().use { response ->
            val body = response.body.string()
            if (!response.isSuccessful) throw IllegalStateException(message(body, "Nie udało się połączyć z Flip Managerem."))
            JSONObject(body)
        }
    }

    private fun endpoint(path: String): String = "${baseUrl.trimEnd('/')}$path"

    private fun message(body: String, fallback: String): String = runCatching {
        JSONObject(body).optString("message", fallback)
    }.getOrDefault(fallback)

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
