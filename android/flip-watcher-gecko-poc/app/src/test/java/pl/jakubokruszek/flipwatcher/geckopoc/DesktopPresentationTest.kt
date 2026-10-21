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
}
