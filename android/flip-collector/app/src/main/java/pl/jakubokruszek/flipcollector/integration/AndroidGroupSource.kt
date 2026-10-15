package pl.jakubokruszek.flipcollector.integration

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import pl.jakubokruszek.flipcollector.collector.SignedCollectorClient
import pl.jakubokruszek.flipcollector.collector.CollectorHttpException

class AndroidGroupSource(private val client: SignedCollectorClient) : GroupSource {
    override suspend fun fetch(): GroupFetchResult = withContext(Dispatchers.IO) {
        try { GroupFetchResult.Success(client.sources()) }
        catch (error: CollectorHttpException) { GroupFetchResult.Failure(error.code) }
        catch (_: Exception) { GroupFetchResult.Failure("ANDROID_SOURCE_SYNC_FAILED") }
    }
}
