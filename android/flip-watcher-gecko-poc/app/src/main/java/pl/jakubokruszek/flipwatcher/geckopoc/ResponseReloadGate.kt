package pl.jakubokruszek.flipwatcher.geckopoc

/** Native UI exception for ONE operator-requested reload; JS independently enforces the main_frame budget. */
class ResponseReloadGate {
    var active = false; private set
    private var target = ""
    private var started = false
    private var requestSeen = false
    private var oldDisconnect = false
    fun begin(url: String) { active = true; target = url; started = false; requestSeen = false; oldDisconnect = true }
    fun willLoad() { if (active) started = true }
    fun allowRequest(url: String, redirect: Boolean, newWindow: Boolean): Boolean {
        if (!active || !started || requestSeen || url != target || redirect || newWindow) return false
        requestSeen = true; return true
    }
    fun allowLocation(url: String?): Boolean = active && started && url == target
    fun allowOldDisconnect(): Boolean {
        if (!active || !started || !oldDisconnect) return false
        oldDisconnect = false; return true
    }
    fun connected() { if (active && started) oldDisconnect = false }
    fun cancel() { active = false; started = false; oldDisconnect = false }
}
