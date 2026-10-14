package pl.jakubokruszek.flipcollector

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.google.android.gms.code.scanner.GmsBarcodeScanning
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import pl.jakubokruszek.flipcollector.watcher.android.WatcherRuntime
import pl.jakubokruszek.flipcollector.watcher.android.WatcherSettingsScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Re-register the periodic tick after an update or a cleared WorkManager state.
        WatcherRuntime.applySchedule(this, WatcherRuntime.settings(this).schedule())
        setContent {
            MaterialTheme {
                var screen by remember { mutableStateOf(Screen.HOME) }
                when (screen) {
                    Screen.HOME -> CollectorHome(this@MainActivity, onOpenWatcher = { screen = Screen.WATCHER })
                    Screen.WATCHER -> {
                        BackHandler { screen = Screen.HOME }
                        WatcherSettingsScreen(this@MainActivity, onBack = { screen = Screen.HOME })
                    }
                }
            }
        }
    }
}

private enum class Screen { HOME, WATCHER }

@Composable
private fun CollectorHome(activity: ComponentActivity, onOpenWatcher: () -> Unit) {
    val context = activity.applicationContext
    val preferences = UploadRetryWorker.preferences(context)
    val tokenStore = remember { DeviceTokenStore(context) }
    val queue = remember { PendingImportStore(context) }
    var manualToken by remember { mutableStateOf("") }
    var manualDeviceId by remember { mutableStateOf("") }
    var paired by remember { mutableStateOf(tokenStore.token() != null) }
    var manualUrl by remember { mutableStateOf(preferences.getString(UploadRetryWorker.KEY_BASE_URL, BuildConfig.DEFAULT_FLIP_MANAGER_URL).orEmpty()) }
    var message by remember { mutableStateOf<String?>(null) }
    var connectedName by remember { mutableStateOf<String?>(null) }
    val scanner = remember { GmsBarcodeScanning.getClient(activity) }

    fun connect(payload: PairingPayload) {
        activity.lifecycleScope.launch {
            message = withContext(Dispatchers.IO) {
                runCatching {
                    val current = CollectorApi(payload.apiUrl).currentDevice(payload.deviceToken)
                    tokenStore.saveToken(payload.deviceToken, payload.deviceId)
                    paired = true
                    preferences.edit().putString(UploadRetryWorker.KEY_BASE_URL, payload.apiUrl).apply()
                    connectedName = current.optString("deviceName", "Urządzenie")
                    "Połączono z Flip Managerem: $connectedName"
                }.getOrElse { "Nie udało się połączyć: ${it.message ?: "nieznany błąd"}" }
            }
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Flip Collector", style = MaterialTheme.typography.headlineMedium)
        Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(if (!paired) "Urządzenie nie jest sparowane" else "Urządzenie połączone")
            connectedName?.let { Text("Urządzenie: $it") }
            Text("Ostatni import: ${preferences.getString("last_import", null) ?: "brak"}")
            Text("Importy oczekujące: ${queue.all().size}")
        } }
        OutlinedButton(onClick = onOpenWatcher, modifier = Modifier.fillMaxWidth()) { Text("Facebook Watcher → Ustawienia skanowania") }
        if (!paired) {
            Text("Połącz z Flip Managerem", style = MaterialTheme.typography.titleMedium)
            Button(onClick = { scanner.startScan().addOnSuccessListener { barcode -> parsePairingPayload(barcode.rawValue.orEmpty())?.let(::connect) ?: run { message = "Kod QR parowania jest nieprawidłowy." } }.addOnFailureListener { message = "Nie udało się odczytać kodu QR." } }) { Text("Skanuj kod QR") }
            OutlinedTextField(manualUrl, { manualUrl = it }, label = { Text("Adres HTTPS Flip Managera") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(manualDeviceId, { manualDeviceId = it }, label = { Text("ID urządzenia (do podpisanych żądań)") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            OutlinedTextField(manualToken, { manualToken = it }, label = { Text("Token urządzenia — awaryjnie") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            Button(enabled = manualUrl.startsWith("https://") && manualToken.isNotBlank(), onClick = { connect(PairingPayload(manualUrl.trimEnd('/'), manualToken.trim(), manualDeviceId.trim().ifBlank { DeviceTokenStore.MANUAL_DEVICE_ID })) }) { Text("Połącz ręcznie") }
        } else Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { WorkManager.getInstance(context).enqueueUniqueWork("flip-collector-upload", ExistingWorkPolicy.KEEP, OneTimeWorkRequestBuilder<UploadRetryWorker>().build()); message = "Uruchomiono synchronizację oczekujących importów." }) { Text("Wyślij oczekujące") }
            Button(onClick = { tokenStore.clearToken(); paired = false; connectedName = null; message = "Token usunięty z telefonu." }) { Text("Odłącz") }
        }
        Text("Samsung: Ustawienia → Aplikacje → Flip Collector → Bateria → Bez ograniczeń.")
        message?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
    }
}
