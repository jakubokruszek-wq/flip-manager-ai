package pl.jakubokruszek.flipcollector.integration

/**
 * What the app still needs from the backend contract that Codex is writing.
 * No request or response shape is guessed here: until the contract document
 * is in the repository, every item stays [IntegrationState.PENDING_CONTRACT]
 * and the app makes none of these calls. When the contract lands, each item
 * gets a client next to collector/SignedCollectorClient.kt and a test pinned
 * to the contract's examples.
 */
enum class IntegrationState(val label: String) {
    PENDING_CONTRACT("Oczekuje na kontrakt backendu"),
    VALIDATION_PENDING("Implementacja wyłączona; oczekuje na walidację"),
    READY("Gotowe"),
}

data class IntegrationItem(val id: String, val title: String, val needs: String, val state: IntegrationState = IntegrationState.VALIDATION_PENDING)

object BackendIntegration {
    /** Path of the contract document once it exists; null while it does not. */
    val CONTRACT_DOCUMENT: String? = "docs/facebook-android-backend-contract.md"

    val items: List<IntegrationItem> = listOf(
        IntegrationItem("groups", "Lista grup z Flip Managera", "Odczyt obserwowanych grup bez odświeżania heartbeatu urządzenia."),
        IntegrationItem("device-status", "Status urządzenia", "Zgłaszanie trybu, baterii, ładowania, Wi-Fi i ostatniego skanu."),
        IntegrationItem("remote-config", "Konfiguracja z serwera", "Harmonogram i limity ustawiane w Flip Managerze zamiast w telefonie."),
        IntegrationItem("job-queue", "Kolejka zadań", "Pobieranie zadania dla wybranej grupy, lease i heartbeat zadania."),
        IntegrationItem("results", "Wysyłka wyników", "Przekazywanie zebranych postów; w trybie demo nic nie jest wysyłane."),
    )
}
