package pl.jakubokruszek.flipcollector

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MaterialTheme { CollectorHome(this@MainActivity) } }
    }
}

private fun CollectorHome(activity: ComponentActivity) {
    val context = activity.applicationContext
    val preferences = UploadRetryWorker.preferences(context)
    val tokenStore = remember { DeviceTokenStore(context) }
    val queue = remember { PendingImportStore(context) }
    var manualToken by remember { mutableStateOf("") }
    var manualUrl by remember { mutableStateOf(preferences.getString(UploadRetryWorker.KEY_BASE_URL, BuildConfig.DEFAULT_FLIP_MANAGER_URL).orEmpty()) }
    var message by remember { mutableStateOf<String?>(null) }
    var connectedName by remember { mutableStateOf<String?>(null) }
    val scanner = remember { GmsBarcodeScanning.getClient(activity) }

    fun connect(payload: PairingPayload) {
        activity.lifecycleScope.launch {
            message = withContext(Dispatchers.IO) {
                runCatching {
                    val current = CollectorApi(payload.apiUrl).currentDevice(payload.deviceToken)
                    tokenStore.saveToken(payload.deviceToken)
                    preferences.edit().putString(UploadRetryWorker.KEY_BASE_URL, payload.apiUrl).apply()
                    connectedName = current.optString("deviceName", "Urządzenie")
                    "Połączono z Flip Managerem: $connectedName"
                }.getOrElse { "Nie udało się połączyć: ${it.message ?: "nieznany błąd"}" }
            }
        }
    }

    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Flip Collector", style = MaterialTheme.typography.headlineMedium)
        Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(if (tokenStore.token() == null) "Urządzenie nie jest sparowane" else "Urządzenie połączone")
            connectedName?.let { Text("Urządzenie: $it") }
            Text("Ostatni import: ${preferences.getString("last_import", null) ?: "brak"}")
            Text("Importy oczekujące: ${queue.all().size}")
        } }
        if (tokenStore.token() == null) {
            Text("Połącz z Flip Managerem", style = MaterialTheme.typography.titleMedium)
            Button(onClick = { scanner.startScan().addOnSuccessListener { barcode -> parsePairingPayload(barcode.rawValue.orEmpty())?.let(::connect) ?: run { message = "Kod QR parowania jest nieprawidłowy." } }.addOnFailureListener { message = "Nie udało się odczytać kodu QR." } }) { Text("Skanuj kod QR") }
            OutlinedTextField(manualUrl, { manualUrl = it }, label = { Text("Adres HTTPS Flip Managera") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(manualToken, { manualToken = it }, label = { Text("Token urządzenia — awaryjnie") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            Button(enabled = manualUrl.startsWith("https://") && manualToken.isNotBlank(), onClick = { connect(PairingPayload(manualUrl, manualToken, "manual")) }) { Text("Połącz ręcznie") }
        } else Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { WorkManager.getInstance(context).enqueueUniqueWork("flip-collector-upload", ExistingWorkPolicy.KEEP, OneTimeWorkRequestBuilder<UploadRetryWorker>().build()); message = "Uruchomiono synchronizację oczekujących importów." }) { Text("Wyślij oczekujące") }
            Button(onClick = { tokenStore.clearToken(); connectedName = null; message = "Token usunięty z telefonu." }) { Text("Odłącz") }
        }
        Text("Samsung: Ustawienia → Aplikacje → Flip Collector → Bateria → Bez ograniczeń.")
        message?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
    }
}
