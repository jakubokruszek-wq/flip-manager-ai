package pl.jakubokruszek.flipcollector.integration

/** Durable cursor belongs to one allowed window and one data domain. */
data class WindowCursor(val windowKey: String, val mode: String, val pending: List<String>, val finished: Set<String> = emptySet())
data class CycleConditions(val screenOn: Boolean, val wifi: Boolean, val charging: Boolean, val batteryPercent: Int?, val thermalSevere: Boolean)
data class NextSource(val id: String?, val reason: String)

object WindowContinuation {
    const val AUTOMATIC_BUDGET_MS = 8 * 60 * 1000L
    fun next(cursor: WindowCursor, mode: String, now: Long, cycleStartedAt: Long, windowEndsAt: Long, conditions: CycleConditions, estimatedSourceMs: Long = 60_000): NextSource {
        require(mode in setOf("DEMO", "LIVE") && estimatedSourceMs > 0 && cycleStartedAt <= now)
        if (cursor.mode != mode) return NextSource(null,"DATA_DOMAIN_MISMATCH")
        if (now >= windowEndsAt) return NextSource(null,"WINDOW_ENDED")
        if (!conditions.screenOn && mode == "LIVE") return NextSource(null,"SCREEN_OFF")
        if (!conditions.wifi || !conditions.charging) return NextSource(null,"DEVICE_CONSTRAINT")
        if (conditions.thermalSevere || conditions.batteryPercent == null || conditions.batteryPercent < 20) return NextSource(null,"BATTERY_OR_THERMAL")
        val deadline = minOf(windowEndsAt, cycleStartedAt + AUTOMATIC_BUDGET_MS)
        if (deadline - now < estimatedSourceMs + 35_000) return NextSource(null,"CONTINUE_NEXT_CYCLE")
        return cursor.pending.firstOrNull { it !in cursor.finished }?.let { NextSource(it,"READY") } ?: NextSource(null,"WINDOW_COMPLETE")
    }
    fun finished(cursor: WindowCursor, id: String): WindowCursor {
        require(id in cursor.pending)
        return cursor.copy(finished = cursor.finished + id)
    }
}
