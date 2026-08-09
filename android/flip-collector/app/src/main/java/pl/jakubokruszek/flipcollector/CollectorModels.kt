package pl.jakubokruszek.flipcollector

import java.security.MessageDigest
import java.util.UUID

data class FacebookImportDraft(
    val sourcePostUrl: String,
    val title: String? = null,
    val groupName: String? = null,
    val authorName: String? = null,
    val publishedAt: String? = null,
    val content: String? = null,
    val price: String = "",
    val area: String = "",
    val rooms: String = "",
    val location: String = "",
    val imageUrls: List<String> = emptyList(),
    val collectedAt: String = java.time.Instant.now().toString(),
    val idempotencyKey: String = UUID.randomUUID().toString(),
)

data class CollectorStatus(
    val baseUrl: String,
    val isPaired: Boolean,
    val lastImport: String?,
    val pendingImports: Int,
    val recentErrors: List<String>,
)

fun sha256Hex(value: String): String = MessageDigest
    .getInstance("SHA-256")
    .digest(value.toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it) }
