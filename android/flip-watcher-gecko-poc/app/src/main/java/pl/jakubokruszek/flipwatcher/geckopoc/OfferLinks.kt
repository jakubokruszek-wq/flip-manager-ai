package pl.jakubokruszek.flipwatcher.geckopoc

/** Only a deliberate click on a current eligible card may use this exact canonical URL. */
object OfferLinks {
    fun validated(row:DesktopRow):String? {
        if(!DesktopSummary.eligible(row)||!Regex("^[0-9]{5,30}$").matches(row.postId))return null
        val expected="https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/${row.postId}/"
        return expected.takeIf{row.permalink==it}
    }
}
