package pl.jakubokruszek.flipcollector.watcher.android

/**
 * External supply check for a manual, synthetic OFFLINE_TEST run.
 * Some OEM firmware reports isCharging=false while a power source is attached.
 * BatteryManager.EXTRA_PLUGGED is a separate OS reading from the sticky
 * ACTION_BATTERY_CHANGED broadcast. Never assume power without either signal.
 */
internal fun externallyPowered(isCharging: Boolean, plugged: Int): Boolean =
    isCharging || plugged == 1 || plugged == 2 || plugged == 4 || plugged == 8
