package pl.jakubokruszek.flipwatcher.geckopoc

/** A photo is evidence of an attached image, not a claim about its visual content. Text posters count. */
object OfferQuality {
    fun confirmedSale(row:DesktopRow)=row.intent=="SELL_PROPERTY"&&row.usable&&row.qualification in setOf("CLASSIFIER","CANDIDATE","MISSING_FIELDS")
    fun reason(row:DesktopRow,storedPhotos:Int):String?=when {
        !confirmedSale(row)->"SALE_NOT_CONFIRMED"
        storedPhotos<1->"PHOTO_REQUIRED"
        else->null
    }
}
