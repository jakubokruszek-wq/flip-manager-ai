package pl.jakubokruszek.flipwatcher.geckopoc

/** Exact canonical links only, after a deliberate click on a current local row. */
object OfferLinks {
    fun validated(row:DesktopRow):String?=if(DesktopSummary.eligible(row))exact(row) else null
    fun validatedReview(row:DesktopRow):String?=if(DesktopPresentation.reviewable(row))exact(row) else null
    private fun exact(row:DesktopRow):String? {
        if(!Regex("^[0-9]{5,30}$").matches(row.postId))return null
        val expected="https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/${row.postId}/"
        return expected.takeIf{row.permalink==it}
    }
}
