package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import kotlinx.coroutines.suspendCancellableCoroutine
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.GeckoRuntimeSettings
import org.mozilla.geckoview.WebExtension
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * The single GeckoRuntime of the process (GeckoView allows one per process)
 * and the built-in collector extension. Both the activity and the screen-off
 * test service use it. Call from the main thread.
 */
object GeckoHost {
    @Volatile private var runtime: GeckoRuntime? = null
    @Volatile private var extension: WebExtension? = null

    fun runtime(context: Context): GeckoRuntime = runtime ?: synchronized(this) {
        runtime ?: GeckoRuntime.create(
            context.applicationContext,
            GeckoRuntimeSettings.Builder()
                // No remote debugging, no about:config and no console mirroring to logcat
                // (page console output could contain personal data).
                .remoteDebuggingEnabled(false)
                .aboutConfigEnabled(false)
                .consoleOutput(false)
                .build(),
        ).also { runtime = it }
    }

    /** Installs the bundled extension once (it persists across app starts) and returns it. */
    suspend fun collectorExtension(context: Context): WebExtension {
        extension?.let { return it }
        val installed = runtime(context).webExtensionController
            .ensureBuiltIn(PocPolicy.EXTENSION_LOCATION, PocPolicy.EXTENSION_ID)
            .await() ?: error("Rozszerzenie nie zostało zainstalowane")
        extension = installed
        return installed
    }
}

/** Bridges a GeckoResult to a coroutine. A null value is passed through. */
suspend fun <T> GeckoResult<T>.await(): T? = suspendCancellableCoroutine { continuation ->
    accept(
        { value -> if (continuation.isActive) continuation.resume(value) },
        { error -> if (continuation.isActive) continuation.resumeWithException(error ?: IllegalStateException("GeckoResult failed")) },
    )
}
