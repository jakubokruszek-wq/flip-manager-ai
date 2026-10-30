package pl.jakubokruszek.flipwatcher.geckopoc

/**
 * Human-readable, privacy-safe summary. Legacy one-shot permission is never
 * reset just because a previous release did not record an attempt outcome.
 */
object ScanAttemptJournal {
    fun summary(
        consumed: Boolean,
        stage: String?,
        status: String?,
        posts: Int,
        rejected: Int,
        startedAt: String?,
        error: String?,
        saveError: String?,
    ): String {
        if (!consumed) return "Skan nie był uruchamiany; zgoda jednorazowa niewykorzystana."
        if (stage.isNullOrBlank()) return "Poprzednia próba: limit wykorzystany w starszej wersji. Brak zapisanego statusu skanu; nie wiadomo, czy żądanie doszło do kolektora. Nie uruchamia się ponownie."
        val time = startedAt?.takeIf { it.isNotBlank() }?.let { " • $it" }.orEmpty()
        val save = saveError?.takeIf { it.isNotBlank() }?.let { " • błąd zapisu: $it" }.orEmpty()
        val cause = error?.takeIf { it.isNotBlank() }?.let { " • powód: $it" }.orEmpty()
        return when (stage) {
            "STARTED" -> "Rozpoczęto próbę$time; brak potwierdzonego zakończenia (możliwe przerwanie). Limit pozostaje wykorzystany.$save"
            "FINISHED" -> "Wynik skanu: ${status ?: "BRAK_STATUSU"} • postów: $posts • odrzucone: $rejected$time$cause$save"
            "ABORTED" -> "Próba przerwana: ${status ?: "NIEZNANY_POWÓD"}$time$cause$save • limit pozostaje wykorzystany."
            else -> "Limit wykorzystany; nieznany etap próby ($stage).$time$save"
        }
    }
}
