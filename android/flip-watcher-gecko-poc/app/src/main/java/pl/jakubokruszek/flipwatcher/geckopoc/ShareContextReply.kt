package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject

/** Reduces a nonce-bound private reply to fixed states; no raw data escapes. */
enum class ShareContextReply {
    ABSENT, MALFORMED, STALE, UNSAFE, LOADING, COMPLETE;
    companion object {
        fun parse(reply: JSONObject?, nonce: String): ShareContextReply {
            if(reply==null)return ABSENT
            if(reply.keys().asSequence().toSet()!=setOf("type","nonce","safe","complete","fresh") ||
                reply.optString("type")!="shareLinkContextResult" || reply.opt("nonce")!=nonce ||
                reply.opt("safe") !is Boolean || reply.opt("complete") !is Boolean || reply.opt("fresh") !is Boolean)return MALFORMED
            if(!reply.getBoolean("safe"))return UNSAFE
            if(!reply.getBoolean("fresh"))return STALE
            return if(reply.getBoolean("complete"))COMPLETE else LOADING
        }
    }
}
