package pl.jakubokruszek.flipwatcher.geckopoc

import org.junit.Assert.*
import org.junit.Test

class OfferQualityTest {
    private fun row()=DesktopRow("123456789","https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/123456789/","DOM",430000.0,"EXPLICIT_TOTAL",50.0,2,"Bałuty",null,null,"SELL_PROPERTY",true,0)
    @Test fun actualStoredPhotoRequiredEvenWhenPageClaimsMany(){
        assertEquals("PHOTO_REQUIRED",OfferQuality.reason(row().copy(photos=20),0))
        assertNull(OfferQuality.reason(row(),1)) // The actual stored image can contain text.
    }
    @Test fun nonSaleAndUncertainPostsCannotBecomeOffersByHavingPictures(){
        for(intent in listOf("UNKNOWN","BUY_PROPERTY","RENT_OFFER","RENT_WANTED","SERVICE","OTHER"))assertEquals("SALE_NOT_CONFIRMED",OfferQuality.reason(row().copy(intent=intent),1))
        for(qualification in listOf("NO_TEXT","FOREIGN_CITY","NOT_PROPERTY","INTENT","CONFLICT"))assertEquals("SALE_NOT_CONFIRMED",OfferQuality.reason(row().copy(qualification=qualification),1))
        assertEquals("SALE_NOT_CONFIRMED",OfferQuality.reason(row().copy(usable=false),1))
    }
}
