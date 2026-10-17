package pl.jakubokruszek.flipcollector.watcher

/** A watched Facebook group or profile as the phone knows it locally. */
data class WatchedGroup(
    val id: String,
    val name: String,
    val url: String,
    val active: Boolean = true,
)

/** Which groups a scan covers: every active group, or exactly one. */
sealed interface GroupSelection {
    data object AllActive : GroupSelection
    data class Single(val groupId: String) : GroupSelection

    fun resolve(groups: List<WatchedGroup>): List<WatchedGroup> = when (this) {
        AllActive -> groups.filter { it.active }
        is Single -> groups.filter { it.active && it.id == groupId }
    }
}

enum class ScanTrigger { MANUAL, AUTOMATIC }

/** What a scan runs on. Only DEMO exists in this release; LIVE waits for consent and backend integration. */
enum class ScanMode { DEMO, LIVE }

/** Device state the preconditions read; supplied by Android in production, by tests directly. */
data class DeviceConditions(
    val onWifi: Boolean,
    val charging: Boolean,
    val paired: Boolean,
    val batteryPercent: Int? = null,
)

/** Why a scan may not start. Each blocker carries the text the screen shows. */
enum class ScanBlocker(val message: String) {
    AUTOMATION_DISABLED("Automat jest wyłączony."),
    OUTSIDE_WINDOW("Poza oknem skanowania."),
    WIFI_REQUIRED("Wymagane Wi-Fi."),
    CHARGING_REQUIRED("Wymagane ładowanie."),
    NOT_PAIRED("Urządzenie nie jest sparowane z Flip Managerem."),
    NO_GROUPS("Brak aktywnych grup do skanowania."),
    ALREADY_RUNNING("Skan już trwa."),
    LIVE_DISABLED("Skanowanie prawdziwych grup jest wyłączone w tej wersji."),
    WINDOW_FINISHED("Skan w tym oknie już się zakończył."),
    WINDOW_RETRIES_EXHAUSTED("Skan w tym oknie był przerywany ${WindowLedger.MAX_ATTEMPTS} razy — czekam na następne okno."),
}

data class ScanProgress(
    val totalGroups: Int,
    val completedGroups: Int = 0,
    val postsSeen: Int = 0,
    val offersFound: Int = 0,
    val postsSent: Int = 0,
    val errors: Int = 0,
    val currentGroup: String? = null,
    /** Posts read so far in the current group and its expected total, when known. */
    val currentGroupPosts: Int = 0,
    val currentGroupTotal: Int? = null,
)

enum class ScanOutcome(val label: String, val successful: Boolean) {
    COMPLETED("Zakończony", true),
    PARTIAL("Zakończony z błędami", false),
    FAILED("Błąd", false),
    STOPPED("Zatrzymany", false),
    TIMED_OUT("Przekroczony limit czasu", false),
    BLOCKED("Nie uruchomiono", false),
    /** The process died mid-scan; recorded from the journal at the next start. */
    INTERRUPTED("Przerwany (proces zakończony)", false),
    /** Kept so histories written by 0.2.0 still decode. */
    DRY_RUN("Próba bez Facebooka", true),
}

/** One group's line in a scan report. */
data class GroupReport(
    val groupName: String,
    val postsSeen: Int,
    val offersFound: Int,
    val error: String? = null,
)

data class ScanRecord(
    val id: String,
    val trigger: ScanTrigger,
    val startedAt: String,
    val finishedAt: String,
    val outcome: ScanOutcome,
    val groups: Int,
    val postsSeen: Int,
    val postsSent: Int,
    val errors: Int,
    val message: String?,
    val windowKey: String? = null,
    val mode: ScanMode = ScanMode.DEMO,
    val offersFound: Int = 0,
    val groupReports: List<GroupReport> = emptyList(),
    val stopReason: String? = null,
)

/**
 * Pure precondition check shared by "Skanuj teraz" and the automatic tick.
 *
 * - Manual DEMO: nothing is required. It runs on bundled data, opens no
 *   page and calls no API, so it must work unpaired, offline and unplugged.
 * - Automatic DEMO: the schedule the user set (automation on, inside the
 *   window, Wi-Fi and charging if required) — it exists to test that schedule.
 * - LIVE: everything above plus live collection allowed (build flag and
 *   consent), pairing with Flip Manager and at least one active group.
 */
object ScanPreconditions {
    fun evaluate(
        trigger: ScanTrigger,
        schedule: ScanSchedule,
        conditions: DeviceConditions,
        groups: List<WatchedGroup>,
        selection: GroupSelection,
        insideWindow: Boolean,
        mode: ScanMode = ScanMode.DEMO,
        liveAllowed: Boolean = false,
    ): List<ScanBlocker> = buildList {
        if (mode == ScanMode.DEMO && trigger == ScanTrigger.MANUAL) return@buildList
        if (trigger == ScanTrigger.AUTOMATIC) {
            if (!schedule.enabled) add(ScanBlocker.AUTOMATION_DISABLED)
            if (!insideWindow) add(ScanBlocker.OUTSIDE_WINDOW)
        }
        // Wi-Fi and charging protect the data plan and battery: they bind the
        // automatic tick and every live scan, whoever presses the button.
        if (schedule.requireWifi && !conditions.onWifi) add(ScanBlocker.WIFI_REQUIRED)
        if (schedule.requireCharging && !conditions.charging) add(ScanBlocker.CHARGING_REQUIRED)
        if (mode == ScanMode.LIVE) {
            if (!liveAllowed) add(ScanBlocker.LIVE_DISABLED)
            if (!conditions.paired) add(ScanBlocker.NOT_PAIRED)
            if (selection.resolve(groups).isEmpty()) add(ScanBlocker.NO_GROUPS)
        }
    }
}
