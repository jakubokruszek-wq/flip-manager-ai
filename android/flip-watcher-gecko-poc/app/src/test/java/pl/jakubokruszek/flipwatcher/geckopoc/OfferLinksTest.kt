package pl.jakubokruszek.flipwatcher.geckopoc

import org.junit.Assert.*
import org.junit.Test

class OfferLinksTest {
    @Test fun reviewLinksRequireExactApprovedIdentityAndExplicitUnclassifiedStatus(){
        val r=row().copy(price=null,priceSource="NONE",area=null,rooms=null,usable=false,intent="UNKNOWN",qualification="NO_TEXT")
        assertNull(OfferLinks.validated(r));assertEquals(r.permalink,OfferLinks.validatedReview(r))
        assertNull(OfferLinks.validatedReview(r.copy(permalink=r.permalink+"?private=1")))
        assertNull(OfferLinks.validatedReview(r.copy(permalink=r.permalink.replace(PocPolicy.APPROVED_GROUP_ID,"foreign"))))
        assertNull(OfferLinks.validatedReview(r.copy(intent="BUY_PROPERTY")))
        assertNull(OfferLinks.validatedReview(r.copy(qualification="FOREIGN_CITY")))
    }

    private fun row()=DesktopRow("550000000000001","https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/550000000000001/","NETWORK",319000.0,"EXPLICIT_TOTAL",42.42,2,null,null,null,"SELL_PROPERTY",true,0,"CANDIDATE")
    @Test fun onlyTheExactEligibleApprovedPostCanOpen(){assertEquals(row().permalink,OfferLinks.validated(row()))}
    @Test fun credentialsForeignHostsGroupsAndQueryOrFragmentAreRejected(){
        val r=row()
        for(link in listOf(r.permalink+"?token=PRIVATE",r.permalink+"#PRIVATE",r.permalink.replace("www.facebook.com","evil.test"),r.permalink.replace(PocPolicy.APPROVED_GROUP_ID,"foreign"),r.permalink.replace("https://","https://user@"),r.permalink.replace("https://","http://"),"intent://open",r.permalink.replace("/posts/","/photo/")))assertNull(OfferLinks.validated(r.copy(permalink=link)))
    }
    @Test fun missingFakeOrUnboundIdsCannotBecomeLinks(){for(id in listOf("PRIVATE","1234","550000000000002"))assertNull(OfferLinks.validated(row().copy(postId=id)))}
    @Test fun nonCandidatesNeverGetActiveLinks(){val r=row();assertNull(OfferLinks.validated(r.copy(usable=false)));assertNull(OfferLinks.validated(r.copy(intent="BUY_PROPERTY")));assertNull(OfferLinks.validated(r.copy(price=null,priceSource="NONE",area=null,rooms=null)))}
}
