package pl.jakubokruszek.flipwatcher.geckopoc

import org.junit.Assert.*
import org.junit.Test

class OfferFilterTest {
    private fun row()=DesktopRow("550000000000091","https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/550000000000091/","DOM",379000.0,"EXPLICIT",57.0,3,"Bałuty",null,"Inflancka","SELL_PROPERTY",true,0,"CLASSIFIER")
    @Test fun defaultNeverHidesAnyCategory(){
        for(r in listOf(row(),row().copy(usable=false,qualification="NO_TEXT",intent="UNKNOWN",price=null,area=null,rooms=null),row().copy(intent="RENT_OFFER")))assertTrue(OfferFilter().matches(r))
    }
    @Test fun boundsAreInclusiveAndCriteriaIntersect(){
        val r=row();val f=OfferFilter(minPrice=379000.0,maxPrice=379000.0,minArea=57.0,maxArea=57.0,rooms=3,location="BAŁUTY")
        assertTrue(f.matches(r));assertFalse(f.copy(maxPrice=378999.0).matches(r));assertFalse(f.copy(rooms=2).matches(r));assertFalse(f.copy(location="Widzew").matches(r));assertTrue(f.copy(location="inflancka").matches(r))
    }
    @Test fun unknownRetainedByDefaultButKnownMismatchStillRejected(){
        val r=row().copy(price=null,rooms=null,district=null,street=null)
        val f=OfferFilter(maxPrice=100000.0,rooms=2,location="Bałuty")
        assertTrue(f.matches(r));assertFalse(f.copy(includeUnknown=false).matches(r));assertFalse(f.copy(maxArea=40.0).matches(r))
        assertTrue(OfferFilter(includeUnknown=false).matches(r))
    }
    @Test fun sectionsKeepManualReviewDistinctFromExcluded(){
        val offer=row();val review=offer.copy(usable=false,qualification="NO_TEXT",intent="UNKNOWN",price=null,area=null,rooms=null)
        val excluded=offer.copy(intent="RENT_OFFER")
        assertTrue(OfferFilter(section=OfferFilter.Section.OFFERS).matches(offer));assertFalse(OfferFilter(section=OfferFilter.Section.REVIEW).matches(offer))
        assertTrue(OfferFilter(section=OfferFilter.Section.REVIEW).matches(review));assertFalse(OfferFilter(section=OfferFilter.Section.EXCLUDED).matches(review));assertTrue(OfferFilter(section=OfferFilter.Section.EXCLUDED).matches(excluded))
        assertTrue(OfferFilter(section=OfferFilter.Section.MISSING).matches(review))
    }
    @Test fun filteringDoesNotChangeRowsOrEnrichmentQueue(){
        val rows=listOf(row(),row().copy(postId="550000000000092",usable=false,qualification="NO_TEXT",intent="UNKNOWN",price=null,area=null,rooms=null))
        val before=rows.toList();val queue=ReviewDataGate.queue(rows)
        assertTrue(rows.filter{OfferFilter(maxPrice=1.0,includeUnknown=false).matches(it)}.isEmpty())
        assertEquals(before,rows);assertEquals(queue,ReviewDataGate.queue(rows))
    }
}
