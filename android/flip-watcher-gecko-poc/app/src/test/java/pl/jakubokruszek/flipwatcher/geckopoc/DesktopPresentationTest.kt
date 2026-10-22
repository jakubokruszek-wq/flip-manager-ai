package pl.jakubokruszek.flipwatcher.geckopoc

import org.junit.Assert.*
import org.junit.Test

class DesktopPresentationTest {
    private fun row(id:String,intent:String="SELL_PROPERTY",usable:Boolean=true)=DesktopRow(id,"https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/$id/","DOM",319000.0,"EXPLICIT_TOTAL",42.42,2,"Polesie","Retkinia",null,intent,usable,1)
    @Test fun candidateIsShownFirstEvenWhenNonOfferWasDiscoveredFirst(){
        val text=DesktopPresentation.preview("AGGREGATE",listOf(row("550000000000001","BUY_PROPERTY",false),row("550000000000002")),true)
        assertTrue(text.startsWith("KANDYDACI OFERT: 1"));assertTrue(text.indexOf("KANDYDAT 1")<text.indexOf("550000000000002"))
        assertTrue(text.indexOf("550000000000002")<text.indexOf("550000000000001"));assertTrue(text.indexOf("550000000000001")<text.indexOf("RAPORT TECHNICZNY"))
        assertTrue(text.contains("42,42 m²"));assertTrue(text.contains("Retkinia"));assertTrue(text.endsWith("AGGREGATE"))
    }
    @Test fun aggregateOnlyHistoryExplainsMissingDetailsBeforeCounters(){
        val text=DesktopPresentation.preview("CONDITIONAL_GO",emptyList(),true)
        assertTrue(text.startsWith("BRAK SZCZEGÓŁÓW OFERT W PAMIĘCI"));assertTrue(text.contains("nową zgodą"));assertFalse(text.contains("KANDYDAT 1"))
    }
    @Test fun nonOffersNeverAppearAsCandidateCards(){
        val text=DesktopPresentation.preview("AGGREGATE",listOf(row("550000000000001","BUY_PROPERTY",false)),true)
        assertTrue(text.startsWith("KANDYDACI OFERT: 0"));assertFalse(text.contains("KANDYDAT 1"));assertFalse(text.contains("Cena:"))
    }
    @Test fun noScrollAttemptIsExplicitButTwentyIdCapIsNotReportedAsMissingContainer(){
        val stats=DesktopProtocol.emptyStats().toMutableMap().apply{put("candidates",3)}
        val reply=DesktopReply("OK","DONE",emptyList(),stats)
        assertTrue(DesktopSummary.create("DONE",1,reply).report().contains("przewijanie nie rozpoczęło się"))
        stats["candidates"]=20
        assertFalse(DesktopSummary.create("DONE",1,reply).report().contains("przewijanie nie rozpoczęło się"))
    }
    @Test fun eachExcludedPostHasAFixedReasonWithoutRestoringRawText(){
        for((reason,expected) in listOf("NO_TEXT" to "Brak tekstu", "FOREIGN_CITY" to "inne miasto", "NOT_PROPERTY" to "nie spełnił reguł", "MISSING_FIELDS" to "Brak rozpoznanej ceny", "CONFLICT" to "Sprzeczne konkretne intencje")){
            val r=row("550000000000001",usable=false).copy(qualification=reason)
            val text=DesktopPresentation.preview("SAFE_COUNTS",listOf(r),true)
            assertTrue(text.contains("Powód:"));assertTrue(text.contains(expected));assertFalse(text.contains("KANDYDAT 1"))
        }
    }
    @Test fun intentReasonsSeparateBuyRentalServicesAndUnknownCause(){
        for((intent,expected) in listOf("BUY_PROPERTY" to "prośba zakupu", "RENT_OFFER" to "oferta najmu", "RENT_WANTED" to "poszukiwanie najmu", "SERVICE" to "usługowe", "UNKNOWN" to "dokładnej przyczyny nie ustalono"))
            assertTrue(DesktopPresentation.explanation(row("550000000000001",intent,false)).contains(expected))
    }
    @Test fun oldAggregateHistoryIsReadableWithoutInventingNewContainerEvidence(){
        val current=DesktopSummary.create("EMPTY",1)
        val old=org.json.JSONObject(current.encode());val stats=old.getJSONObject("stats")
        for(key in DesktopProtocol.statKeys.drop(22))stats.remove(key)
        val raw=old.toString();val restored=DesktopSummary.decode(raw)!!
        assertEquals(0,restored.stats.getValue("scrollSeen"));assertEquals(raw,old.toString())
        stats.put("PRIVATE",1);assertNull(DesktopSummary.decode(old.toString()))
    }
}
