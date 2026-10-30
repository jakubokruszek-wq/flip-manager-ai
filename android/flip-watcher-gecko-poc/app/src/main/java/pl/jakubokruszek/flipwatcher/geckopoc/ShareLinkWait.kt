package pl.jakubokruszek.flipwatcher.geckopoc

/** Fixed last unmet condition. No address, ID, timestamps or page data. */
enum class ShareLinkWait(val code: String, val explanation: String) {
    LOCATION("DEADLINE_LOCATION", "Nie uzyskano bieżącego adresu powiązanego z zaakceptowanym żądaniem."),
    SOURCE_LOADING("DEADLINE_SOURCE_LOADING", "Pierwsza strona nie zakończyła ładowania; ponowne otwarcie adresu nie zostało rozpoczęte."),
    PORT("DEADLINE_PORT", "Brak połączenia z portem rozszerzenia dla strony."),
    NEW_PORT("DEADLINE_NEW_PORT", "Nie pojawił się nowy port po rozpoczęciu nawigacji. Stary port nie został zaakceptowany."),
    PORT_ADDRESS("DEADLINE_PORT_ADDRESS", "Adres zaufanego portu nie odpowiadał bieżącemu adresowi natywnemu."),
    CONTEXT_REPLY("DEADLINE_CONTEXT_REPLY", "Nie otrzymano odpowiedzi prywatnej kontroli kontekstu."),
    CONTEXT_PROTOCOL("DEADLINE_CONTEXT_PROTOCOL", "Odpowiedź kontroli kontekstu miała niezgodny format lub nonce."),
    DOCUMENT_FRESHNESS("DEADLINE_DOCUMENT_FRESHNESS", "Nie potwierdzono dokumentu utworzonego po rozpoczęciu nawigacji; możliwy stary dokument lub niedostępne metadane świeżości."),
    DOCUMENT_COMPLETE("DEADLINE_DOCUMENT_COMPLETE", "Bezpieczny świeży dokument nie osiągnął stanu complete."),
    NATIVE_PROGRESS("DEADLINE_NATIVE_PROGRESS", "Dokładny adres i kompletny świeży dokument były dostępne, ale natywny postęp nie osiągnął 100%."),
    EXACT_PERMALINK("DEADLINE_EXACT_PERMALINK", "Bezpieczny świeży dokument był kompletny, lecz adres pozostał linkiem udostępnienia bez dokładnego ID posta zatwierdzonej grupy.");
    companion object {
        fun isTimeoutReason(reason: String)=reason=="DEADLINE" || values().any { it.code==reason }
    }
}
