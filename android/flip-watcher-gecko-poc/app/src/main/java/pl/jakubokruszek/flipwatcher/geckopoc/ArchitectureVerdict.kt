package pl.jakubokruszek.flipwatcher.geckopoc

enum class ArchitectureDecision { GO, CONDITIONAL_GO, NO_GO, INCOMPLETE }

data class ArchitectureVerdictResult(val decision: ArchitectureDecision, val reason: String)

/**
 * GO / CONDITIONAL GO / NO-GO for "identify posts through GeckoView" from the
 * two device measurements: the listener control test and the last post
 * diagnosis. Only exact ids from DOM links or page scripts count; image,
 * video, comment or other long numbers never do. Pure Kotlin.
 */
object ArchitectureVerdict {
    fun decide(control: ControlStatus?, diagnosis: StructureDiagnosis?): ArchitectureVerdictResult {
        if (control == null) return ArchitectureVerdictResult(ArchitectureDecision.INCOMPLETE, "Najpierw „Test sieci GeckoView”.")
        when (control) {
            ControlStatus.TIMEOUT, ControlStatus.LISTENER_NOT_OBSERVED -> return ArchitectureVerdictResult(
                ArchitectureDecision.NO_GO,
                "Nasłuch sieci nie działa wiarygodnie w tym GeckoView ($control). Dalsza diagnostyka sieci nie ma sensu; zostają metody bez sieci (patrz alternatywy).",
            )
            ControlStatus.WRONG_TAB -> return ArchitectureVerdictResult(
                ArchitectureDecision.CONDITIONAL_GO,
                "Nasłuch widzi żądania, ale z innym tabId. Jedna poprawka mapowania kart i jeden ponowny pomiar.",
            )
            ControlStatus.LISTENER_OK -> Unit
        }
        if (diagnosis == null || diagnosis.status != "GROUP_OK") return ArchitectureVerdictResult(ArchitectureDecision.INCOMPLETE, "Nasłuch działa. Teraz „Diagnoza postów” na zatwierdzonej grupie.")
        val c = diagnosis.counts
        fun n(key: String) = c[key] ?: 0
        val exact = n("domExactIds") + n("scriptExactIds")
        val facebookData = n("netTabXhr") + n("netTabScript") + n("netTabOther") + n("netTabWebsocket") + n("netTabSubFrame")
        return when {
            exact > 0 -> ArchitectureVerdictResult(ArchitectureDecision.GO, "Nasłuch działa i strona sama zawiera $exact dokładnych ID postów (z permalinkiem grupy).")
            facebookData > 0 -> ArchitectureVerdictResult(
                ArchitectureDecision.NO_GO,
                "Nasłuch działa; Facebook doładowuje dane ($facebookData żądań danych w oknie), ale ani DOM, ani skrypty strony nie niosą ID posta. ID są tylko w treści odpowiedzi, której ta architektura celowo nie czyta.",
            )
            n("netFbcdnTab") > 0 -> ArchitectureVerdictResult(
                ArchitectureDecision.CONDITIONAL_GO,
                "Nasłuch widzi tę kartę (${n("netFbcdnTab")} obrazów), ale w oknie nie było żądań danych Facebooka: lista była już pobrana i jest tylko przewijana/recyklingowana. Potrzebny jeden pomiar obejmujący ładowanie strony grupy.",
            )
            n("netOtherTabTotal") > 0 -> ArchitectureVerdictResult(
                ArchitectureDecision.CONDITIONAL_GO,
                "Ruch Facebooka trafia pod inny tabId niż karta grupy (${n("netOtherTabTotal")}). Jedna poprawka mapowania kart i ponowny pomiar.",
            )
            else -> ArchitectureVerdictResult(
                ArchitectureDecision.CONDITIONAL_GO,
                "Nasłuch działa (test kontrolny), ale w oknie karta grupy nie wysłała żadnego żądania (także obrazów — prawdopodobnie pamięć podręczna). Potrzebny jeden pomiar obejmujący ładowanie strony grupy.",
            )
        }
    }

    const val ALTERNATIVES = "Alternatywy bez czytania odpowiedzi: (1) operator udostępnia post („Udostępnij → Kopiuj link”) do aplikacji — dokładny permalink bez zgadywania; (2) osobna, świadoma zgoda na odczyt treści wyłącznie dokumentu zatwierdzonej grupy; (3) powiadomienia Facebooka o nowych postach jako wyzwalacz."
}
