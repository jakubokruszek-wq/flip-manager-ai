package pl.jakubokruszek.flipwatcher.geckopoc

/** Closing a source ends its queue entry, not the recorded quality warning. */
internal object SourceRetryPolicy {
    // Gecko ERROR_UNKNOWN_HOST = 0x25, category URI = 0x5.
    fun pauseForNetwork(issue:String):Boolean = issue in setOf("GROUP_LOAD_ERROR_C5_E37","PROFILE_LOAD_ERROR_C5_E37")
    fun closeCapture(issue:String,alreadyAttempted:Boolean):Boolean =
        issue.isEmpty() || issue=="SALE_PHOTO_MISSING" || alreadyAttempted

    fun closeFailure(issue:String,alreadyAttempted:Boolean):Boolean {
        if(pauseForNetwork(issue))return false
        if(issue in setOf("LOGIN_REQUIRED","CAPTCHA","CHECKPOINT","WAITING_FOR_BACKGROUND"))return false
        // BackgroundLoadRetry already opened a fresh session once. A second
        // outer pass would multiply the same failed work without new evidence.
        val exhaustedLoad=listOf("GROUP","PROFILE").any{prefix ->
            issue=="${prefix}_NOT_READY" || issue=="${prefix}_RENDER_RETRY_FAILED" ||
                issue=="${prefix}_LOAD_ERROR" || issue.startsWith("${prefix}_LOAD_ERROR_")
        }
        return alreadyAttempted || exhaustedLoad
    }
}
