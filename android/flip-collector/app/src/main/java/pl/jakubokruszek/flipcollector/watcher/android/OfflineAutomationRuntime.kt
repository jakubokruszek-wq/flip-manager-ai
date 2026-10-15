package pl.jakubokruszek.flipcollector.watcher.android

import android.content.Context
import android.os.PowerManager
import android.os.Build
import kotlinx.coroutines.Job
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.job
import okhttp3.OkHttpClient
import pl.jakubokruszek.flipcollector.BuildConfig
import pl.jakubokruszek.flipcollector.collector.*
import pl.jakubokruszek.flipcollector.integration.*
import java.net.URI
import java.security.KeyStore
import java.security.cert.CertificateFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/** Explicit debug loopback fixture, unrelated to the paired production device. */
object OfflineAutomationRuntime {
    private val running=java.util.concurrent.atomic.AtomicReference<Job?>()
    fun isRunning()=running.get()?.isActive==true
    fun stop() { running.get()?.cancel(CancellationException("OFFLINE_MANUAL_STOP")) }
    private fun prefs(context: Context)=context.getSharedPreferences("flip_offline_fixture_config",Context.MODE_PRIVATE)
    fun enabled(context: Context)=BuildConfig.DEBUG && prefs(context).getBoolean("enabled",false)
    fun configure(context: Context, origin: String, certificate: String) {
        check(BuildConfig.DEBUG && !BuildConfig.LIVE_COLLECTION_ENABLED && !BuildConfig.ANDROID_BACKEND_INTEGRATION_ENABLED)
        check(running.get()==null) { "OFFLINE_CYCLE_RUNNING" }
        val uri=URI(origin)
        require(uri.scheme=="https" && uri.host in setOf("localhost","127.0.0.1","10.0.2.2") && uri.userInfo==null && uri.rawQuery==null && uri.fragment==null && uri.path.orEmpty() in setOf("","/"))
        require(certificate.length<=16384)
        CertificateFactory.getInstance("X.509").generateCertificate(certificate.byteInputStream())
        val old=prefs(context)
        if(state(context).load()!=null || state(context).activeJob()!=null)
            check(old.getString("origin",null)==origin.trimEnd('/') && old.getString("certificate",null)==certificate) { "UNSETTLED_FIXTURE_CANNOT_CHANGE" }
        check(prefs(context).edit().putString("origin",origin.trimEnd('/')).putString("certificate",certificate).putBoolean("remote",false).putBoolean("enabled",true).commit())
    }
    private fun profileStorage(context: Context) = EncryptedAutomationStorage(context, CollectorSigner.sha256Hex("OFFLINE_TEST_REMOTE_PROFILE".toByteArray()))
    fun configureRemote(context: Context, raw: String) {
        check(BuildConfig.DEBUG && !BuildConfig.LIVE_COLLECTION_ENABLED && !BuildConfig.ANDROID_BACKEND_INTEGRATION_ENABLED)
        check(running.get()==null) { "OFFLINE_CYCLE_RUNNING" }
        val profile = OfflineTestProfile.parse(raw, BuildConfig.OFFLINE_TEST_API_ORIGIN)
        check(state(context).load()==null && state(context).activeJob()==null) { "UNSETTLED_FIXTURE_CANNOT_CHANGE" }
        profileStorage(context).write(raw)
        check(prefs(context).edit().putString("origin",profile.credentials.baseUrl).putBoolean("remote",true).putBoolean("enabled",true).commit())
    }
    fun disable(context: Context) {
        check(prefs(context).edit().putBoolean("enabled",false).commit())
        stop()
        androidx.work.WorkManager.getInstance(context).cancelUniqueWork("flip-offline-continuation")
    }
    fun state(context: Context): AutomationState {
        val origin=prefs(context).getString("origin",null) ?: "not-configured"
        return AutomationState(EncryptedAutomationStorage(context,CollectorSigner.sha256Hex(("OFFLINE_TEST:"+origin).toByteArray())))
    }
    fun client(context: Context): SignedCollectorClient {
        check(enabled(context))
        val config=prefs(context)
        val origin=requireNotNull(config.getString("origin",null))
        if(config.getBoolean("remote",false)) {
            val profile=OfflineTestProfile.parse(requireNotNull(profileStorage(context).read()), BuildConfig.OFFLINE_TEST_API_ORIGIN)
            check(profile.credentials.baseUrl==origin)
            return SignedCollectorClient(profile.credentials,LiveCollectionGate(false,false),metadataEnabled=true,dataMode="OFFLINE_TEST",offlineTestProfile=profile)
        }
        val cert=CertificateFactory.getInstance("X.509").generateCertificate(requireNotNull(config.getString("certificate",null)).byteInputStream())
        val keys=KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("isolated-fixture",cert) }
        val factory=TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(keys) }
        val trust=factory.trustManagers.single() as X509TrustManager
        val tls=SSLContext.getInstance("TLS").apply { init(null,arrayOf(trust),null) }
        val http=OkHttpClient.Builder().sslSocketFactory(tls.socketFactory,trust).callTimeout(30,java.util.concurrent.TimeUnit.SECONDS).build()
        return SignedCollectorClient(CollectorCredentials(origin,"00000000-0000-4000-8000-000000000001","isolated-ci-device-token"),
            LiveCollectionGate(false,false),http,metadataEnabled=true,dataMode="OFFLINE_TEST")
    }
    fun conditions(context: Context): CycleConditions {
        val device=WatcherRuntime.conditions(context)
        val power=context.getSystemService(PowerManager::class.java)
        return CycleConditions(power?.isInteractive==true,device.onWifi,device.charging,device.batteryPercent,
            Build.VERSION.SDK_INT>=29 && (power?.currentThermalStatus ?: 0)>=PowerManager.THERMAL_STATUS_SEVERE)
    }
    suspend fun run(context: Context, key: String, end: Long, conditions: () -> CycleConditions = { conditions(context) }): String {
        check(enabled(context))
        val job=currentCoroutineContext().job
        if(!running.compareAndSet(null,job)) return "ALREADY_RUNNING"
        try { return OfflineAutomation(client(context),state(context)).run(key,end,conditions) { OfflineFixtureDocument.batch(context,it) } }
        finally { running.compareAndSet(job,null) }
    }
}
