package pl.jakubokruszek.flipcollector.watcher.android

import android.content.Context
import kotlinx.coroutines.*
import pl.jakubokruszek.flipcollector.BuildConfig
import pl.jakubokruszek.flipcollector.collector.*
import pl.jakubokruszek.flipcollector.integration.EncryptedAutomationStorage

/** Foreground/manual only. Never registered with WorkManager. */
object LivePilotRuntime {
    private val running = java.util.concurrent.atomic.AtomicBoolean(false)
    fun journal(context: Context) = LivePilotJournal(EncryptedAutomationStorage(context,
        CollectorSigner.sha256Hex("LIVE_PILOT_43_SEPARATE_JOURNAL".toByteArray())))
    fun available() = BuildConfig.DEBUG && BuildConfig.LIVE_PILOT_ENABLED && BuildConfig.LIVE_PILOT_ORIGIN.isNotEmpty()
    fun profile(context: Context) = LivePilotProfile.parse(requireNotNull(journal(context).profile()), BuildConfig.LIVE_PILOT_ORIGIN)
    fun configure(context: Context, raw: String) {
        check(available() && !running.get())
        LivePilotProfile.parse(raw, BuildConfig.LIVE_PILOT_ORIGIN)
        journal(context).configure(raw)
    }
    suspend fun run(context: Context, browser: WebViewCollectorBrowser, consent: Boolean, retryOnly: Boolean = false) {
        check(available() && consent) { "PILOT_APPROVAL_REQUIRED" }
        check(running.compareAndSet(false, true)) { "PILOT_ALREADY_RUNNING" }
        val state = journal(context)
        try {
            val profile = profile(context)
            val client = SignedCollectorClient(profile.credentials, LiveCollectionGate(true, consent))
            val outbox = CompletionOutbox(state)
            if (retryOnly) {
                withContext(Dispatchers.IO) {
                    if (outbox.pending() != null) outbox.flush(client, state::acknowledge)
                    else state.active()?.let { job ->
                        // Process died before enqueue: settle the original fenced lease as
                        // failed. Never reopen FB or silently discard the active journal.
                        outbox.enqueue(client.prepareCompletion(job, failure = "PILOT_PROCESS_INTERRUPTED"))
                        outbox.flush(client, state::acknowledge)
                    }
                }
                return
            }
            check(state.active() == null && state.load() == null) { "PILOT_RECOVERY_REQUIRED" }
            check(browser.blockers().isEmpty()) { "SCREEN_OFF" }
            AndroidQueueSession(client, outbox, enabled = true).runOne(listOf(profile.source.remoteId),
                onClaim = { state.claimed(it); profile.source.checkJob(it) },
                onReceipt = state::acknowledge, onHeartbeat = state::heartbeat) { job ->
                profile.source.checkJob(job)
                check(System.currentTimeMillis() < profile.expiresAt) { "PILOT_PROFILE_EXPIRED" }
                LivePilotChannel(context, browser).collect(profile.source).also(state::captured)
            }
        } catch (cancelled: CancellationException) {
            state.stop(if (cancelled is TimeoutCancellationException) "PILOT_TIMEOUT" else "PILOT_CANCELLED")
            throw cancelled
        } catch (error: Exception) {
            val code = if (error is CollectorHttpException) error.code else error.message.orEmpty()
            state.stop(code.takeIf { it in STOP_CODES } ?: "PILOT_FAILED")
            throw error
        } finally { running.set(false) }
    }
    private val STOP_CODES = setOf("SCREEN_OFF", "LOGIN_REQUIRED", "CHECKPOINT", "CAPTCHA", "GROUP_UNAVAILABLE", "NO_VERIFIED_POSTS",
        "PILOT_REDIRECT_BLOCKED", "PILOT_ORIGIN_FRAME_REJECTED", "HTTP_403", "HTTP_ERROR", "WEBVIEW_NETWORK_ERROR", "RENDERER_GONE",
        "LOGIN_OR_GROUP_UNAVAILABLE", "PILOT_RECOVERY_REQUIRED", "ANDROID_JOB_LEASE_LOST", "PILOT_PROFILE_EXPIRED", "PILOT_SOURCE_JOB_MISMATCH")
}
