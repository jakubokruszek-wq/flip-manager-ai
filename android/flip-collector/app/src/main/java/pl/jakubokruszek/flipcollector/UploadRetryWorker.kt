package pl.jakubokruszek.flipcollector

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class UploadRetryWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val tokenStore = DeviceTokenStore(applicationContext)
        val token = tokenStore.token() ?: return@withContext Result.retry()
        val queue = PendingImportStore(applicationContext)
        val api = CollectorApi(preferences(applicationContext).getString(KEY_BASE_URL, BuildConfig.DEFAULT_FLIP_MANAGER_URL)!!)

        try {
            queue.all().forEach { draft ->
                api.importFacebook(token, draft)
                queue.remove(draft.idempotencyKey)
            }
            Result.success()
        } catch (_: Exception) {
            Result.retry()
        }
    }

    companion object {
        const val KEY_BASE_URL = "base_url"
        fun preferences(context: Context) = context.getSharedPreferences("flip_collector", Context.MODE_PRIVATE)
    }
}
