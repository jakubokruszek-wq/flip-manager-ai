package pl.jakubokruszek.flipwatcher.geckopoc

/** Confirmed sale evidence: preserved own text or a stored image, including text posters. */
object OfferQuality {
    fun confirmedSale(row:DesktopRow)=row.intent=="SELL_PROPERTY"&&row.usable&&row.qualification in setOf("CLASSIFIER","CANDIDATE","MISSING_FIELDS")
    fun reason(row:DesktopRow,storedPhotos:Int,postText:String?=null):String?=when {
        !confirmedSale(row)->"SALE_NOT_CONFIRMED"
        storedPhotos<1&&((postText?.trim()?.length?:0)<25||(postText?.length?:0)>12000)->"PHOTO_REQUIRED"
        else->null
    }
}
