package pl.jakubokruszek.flipwatcher.geckopoc

import java.util.Locale

/** Presentation only: never mutates rows, classifier, OCR or review queue. */
data class OfferFilter(
    val minPrice:Double?=null,val maxPrice:Double?=null,
    val minArea:Double?=null,val maxArea:Double?=null,
    val rooms:Int?=null,val location:String="",val includeUnknown:Boolean=true,
    val section:Section=Section.ALL
){
    enum class Section(val label:String){ALL("Wszystkie"),OFFERS("Kandydaci ofert"),REVIEW("Do sprawdzenia"),MISSING("Brakujące pola"),EXCLUDED("Poza kwalifikacją")}
    fun matches(row:DesktopRow):Boolean {
        val eligible=DesktopSummary.eligible(row);val review=DesktopPresentation.reviewable(row)
        if(!when(section){Section.ALL->true;Section.OFFERS->eligible;Section.REVIEW->review;Section.MISSING->DesktopPresentation.missing(row).isNotEmpty();Section.EXCLUDED->!eligible&&!review})return false
        fun range(value:Double?,min:Double?,max:Double?):Boolean = if(min==null&&max==null)true else if(value==null)includeUnknown else (min==null||value>=min)&&(max==null||value<=max)
        if(!range(row.price,minPrice,maxPrice)||!range(row.area,minArea,maxArea))return false
        if(rooms!=null&&(if(row.rooms==null)!includeUnknown else row.rooms!=rooms))return false
        val query=location.trim().lowercase(Locale.ROOT)
        val actual=listOfNotNull(row.district,row.neighborhood,row.street).joinToString(" ").trim()
        return query.isEmpty()||if(actual.isEmpty())includeUnknown else actual.lowercase(Locale.ROOT).contains(query)
    }
}
