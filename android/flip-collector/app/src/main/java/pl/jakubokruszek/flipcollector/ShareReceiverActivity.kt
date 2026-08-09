package pl.jakubokruszek.flipcollector

import android.content.Intent
import android.os.Bundle
import android.util.Patterns
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class ShareReceiverActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val sharedText = intent.takeIf { it.action == Intent.ACTION_SEND }
            ?.getStringExtra(Intent.EXTRA_TEXT)
            .orEmpty()
        setContent {
            MaterialTheme {
                ShareImportForm(this@ShareReceiverActivity, sharedText)
            }
        }
    }
}

private fun ShareImportForm(activity: ComponentActivity, sharedText: String) {
    val context = activity.applicationContext
    val tokenStore = remember { DeviceTokenStore(context) }
    val queue = remember { PendingImportStore(context) }
    var postUrl by remember { mutableStateOf(firstUrl(sharedText)) }
    var title by remember { mutableStateOf("") }
    var content by remember { mutableStateOf(sharedText) }
    var groupName by remember { mutableStateOf("") }
    var price by remember { mutableStateOf("") }
    var area by remember { mutableStateOf("") }
    var rooms by remember { mutableStateOf("") }
    var location by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    var sending by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxSize().padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("Dodaj ofertę z Facebooka", style = MaterialTheme.typography.headlineSmall)
        OutlinedTextField(postUrl, { postUrl = it }, label = { Text("Link posta") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(title, { title = it }, label = { Text("Tytuł") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(groupName, { groupName = it }, label = { Text("Nazwa grupy") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(content, { content = it }, label = { Text("Treść posta") }, modifier = Modifier.fillMaxWidth(), minLines = 3)
        OutlinedTextField(price, { price = it }, label = { Text("Cena (zł)") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(area, { area = it }, label = { Text("Powierzchnia (m²)") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(rooms, { rooms = it }, label = { Text("Pokoje") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(location, { location = it }, label = { Text("Lokalizacja") }, modifier = Modifier.fillMaxWidth())
        Text("Cena za m²: ${calculatedPricePerSqm(price, area)?.let { "%.0f zł/m²".format(it) } ?: "—"}", style = MaterialTheme.typography.bodySmall)
        Button(
            enabled = !sending && postUrl.startsWith("https://"),
            onClick = {
                val draft = FacebookImportDraft(
                    sourcePostUrl = postUrl,
                    title = title.ifBlank { null },
                    groupName = groupName.ifBlank { null },
                    content = content.ifBlank { null },
                    price = price,
                    area = area,
                    rooms = rooms,
                    location = location,
                )
                sending = true
                activity.lifecycleScope.launch {
                    message = withContext(Dispatchers.IO) {
                        val token = tokenStore.token()
                        val baseUrl = UploadRetryWorker.preferences(context)
                            .getString(UploadRetryWorker.KEY_BASE_URL, BuildConfig.DEFAULT_FLIP_MANAGER_URL)
                            .orEmpty()
                        if (token == null) {
                            queue.enqueue(draft)
                            "Import zapisano w kolejce. Sparuj urządzenie w Flip Collector."
                        } else {
                            runCatching {
                                CollectorApi(baseUrl).importFacebook(token, draft)
                                UploadRetryWorker.preferences(context)
                                    .edit().putString("last_import", java.time.Instant.now().toString()).apply()
                                "Oferta została wysłana do Flip Managera."
                            }.getOrElse { error ->
                                queue.enqueue(draft)
                                WorkManager.getInstance(context).enqueueUniqueWork(
                                    "flip-collector-upload",
                                    ExistingWorkPolicy.KEEP,
                                    OneTimeWorkRequestBuilder<UploadRetryWorker>().build(),
                                )
                                "Brak połączenia: import zapisano do ponowienia."
                            }
                        }
                    }
                    sending = false
                }
            },
        ) { Text(if (sending) "Wysyłanie…" else "Wyślij do Flip Managera") }
        message?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
    }
}

private fun firstUrl(value: String): String = Patterns.WEB_URL.matcher(value)
    .takeIf { it.find() }
    ?.group()
    ?.let { if (it.startsWith("http")) it else "https://$it" }
    .orEmpty()
