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

/** Device state the preconditions read; supplied by Android in production, by tests directly. */
data class DeviceConditions(
    val onWifi: Boolean,
    val charging: Boolean,
    val paired: Boolean,
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
}

data class ScanProgress(
    val totalGroups: Int,
    val completedGroups: Int = 0,
    val postsSeen: Int = 0,
    val postsSent: Int = 0,
    val errors: Int = 0,
    val currentGroup: String? = null,
)

enum class ScanOutcome(val label: String) {
    COMPLETED("Zakończony"),
    PARTIAL("Zakończony z błędami"),
    FAILED("Błąd"),
    STOPPED("Zatrzymany"),
    BLOCKED("Nie uruchomiono"),
    DRY_RUN("Próba bez Facebooka"),
}

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
)

/** Pure precondition check shared by "Skanuj teraz" and the automatic tick. */
object ScanPreconditions {
    fun evaluate(
        trigger: ScanTrigger,
        schedule: ScanSchedule,
        conditions: DeviceConditions,
        groups: List<WatchedGroup>,
        selection: GroupSelection,
        insideWindow: Boolean,
    ): List<ScanBlocker> = buildList {
        if (trigger == ScanTrigger.AUTOMATIC) {
            if (!schedule.enabled) add(ScanBlocker.AUTOMATION_DISABLED)
            if (!insideWindow) add(ScanBlocker.OUTSIDE_WINDOW)
        }
        // Wi-Fi and charging requirements bind a manual scan too: they protect
        // the phone's data plan and battery, whoever presses the button.
        if (schedule.requireWifi && !conditions.onWifi) add(ScanBlocker.WIFI_REQUIRED)
        if (schedule.requireCharging && !conditions.charging) add(ScanBlocker.CHARGING_REQUIRED)
        if (!conditions.paired) add(ScanBlocker.NOT_PAIRED)
        if (selection.resolve(groups).isEmpty()) add(ScanBlocker.NO_GROUPS)
    }
}
