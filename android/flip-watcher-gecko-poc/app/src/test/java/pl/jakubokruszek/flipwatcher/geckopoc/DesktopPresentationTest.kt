package pl.jakubokruszek.flipwatcher.geckopoc

import org.junit.Assert.*
import org.junit.Test

class DesktopPresentationTest {
    @Test fun missingFieldsAndSourcesAreExplicitForPartialRows(){
        val partial=row("550000000000091").copy(price=null,priceSource="NONE",area=null,rooms=null,district=null,neighborhood=null,street=null)
        assertEquals(listOf("cena","metraż","pokoje","lokalizacja"),DesktopPresentation.missing(partial))
        assertTrue(DesktopPresentation.completeness(partial).contains("cena"));assertTrue(DesktopPresentation.source(partial).contains("heurystyczne"))
    }
    @Test fun version0531HistoryPadsTextCountersWithoutRewritingAndRejectsInvalidCounts(){
        val original=org.json.JSONObject(DesktopSummary.create("EMPTY",1).encode());for(key in DesktopProtocol.statKeys.drop(112))original.getJSONObject("stats").remove(key)
        val raw=original.toString();val restored=DesktopSummary.decode(raw)!!;for(key in DesktopProtocol.statKeys.drop(112))assertEquals(0,restored.stats.getValue(key));assertEquals(raw,original.toString())
        val stats=org.json.JSONObject(DesktopProtocol.emptyStats()).put("textExpanded",1);assertNull(DesktopProtocol.parseStats(stats));stats.put("textExpandAttempts",1);assertNotNull(DesktopProtocol.parseStats(stats));stats.put("textExpandAttempts",21);assertNull(DesktopProtocol.parseStats(stats))
    }

    @Test fun version0529HistoryPadsDocumentCountersInRamAndBoundsTheirRelationship(){
        val original=org.json.JSONObject(DesktopSummary.create("EMPTY",1).encode())
        for(key in DesktopProtocol.statKeys.drop(109))original.getJSONObject("stats").remove(key)
        val raw=original.toString();val restored=DesktopSummary.decode(raw)!!
        for(key in DesktopProtocol.statKeys.drop(109))assertEquals(0,restored.stats.getValue(key))
        assertEquals(raw,original.toString())
        val stats=org.json.JSONObject(DesktopProtocol.emptyStats()).put("photoDocumentBound",1)
        assertNull(DesktopProtocol.parseStats(stats));stats.put("photoDocumentNodes",1).put("photoDocumentSelected",1);assertNotNull(DesktopProtocol.parseStats(stats))
        stats.put("photoDocumentSelected",2);assertNull(DesktopProtocol.parseStats(stats))
    }

    @Test fun unknownTextPostsRemainReviewableButKnownExcludedIntentsDoNot(){
        val unknown=row("550000000000091",intent="UNKNOWN",usable=false).copy(price=null,priceSource="NONE",area=null,rooms=null,qualification="NO_TEXT")
        assertTrue(DesktopPresentation.reviewable(unknown));assertFalse(DesktopSummary.eligible(unknown))
        assertFalse(DesktopPresentation.reviewable(unknown.copy(qualification="FOREIGN_CITY")))
        assertFalse(DesktopPresentation.reviewable(unknown.copy(intent="BUY_PROPERTY")))
        assertFalse(DesktopPresentation.reviewable(unknown.copy(intent="RENT_OFFER")))
        assertFalse(DesktopPresentation.reviewable(row("550000000000092")))
    }

    @Test fun derivedTotalIsClearlySeparatedFromExplicitAskingPrice(){
        val explicit=row("550000000000091")
        val derived=explicit.copy(price=365400.0,priceSource="DERIVED_FROM_PRICE_PER_M2",area=63.0,rooms=2)
        assertEquals("Cena",DesktopPresentation.priceLabel(explicit))
        assertEquals("Cena wyliczona z ceny za m²",DesktopPresentation.priceLabel(derived))
        val text=DesktopPresentation.preview("AGGREGATE",listOf(derived),true)
        assertTrue(text.contains("Cena wyliczona z ceny za m²:"));assertTrue(text.contains("63 m²"))
    }

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
    @Test fun photosAreNeverPresentedAsCompleteGallery(){
        assertTrue(DesktopPresentation.photos(1).contains("1"));assertTrue(DesktopPresentation.photos(1).contains("pełna liczba zdjęć nieustalona"))
        assertTrue(DesktopPresentation.photos(0).contains("brak rozpoznanego obrazu"));assertTrue(DesktopPresentation.photos(0).contains("nieustalona"))
    }
    @Test fun version0521HistoryPadsOnlyPhotoCountersWithoutMutatingStoredReport(){
        val original=org.json.JSONObject(DesktopSummary.create("EMPTY",1).encode())
        val stats=original.getJSONObject("stats")
        for(key in DesktopProtocol.statKeys.drop(86))stats.remove(key)
        val raw=original.toString()
        val restored=DesktopSummary.decode(raw)!!
        for(key in DesktopProtocol.statKeys.drop(86))assertEquals(0,restored.stats.getValue(key))
        assertEquals(raw,original.toString())
    }
    @Test fun photoAuditIsCountOnlyBoundedAndRequiresTheFreshExactSchema(){
        val stats=DesktopProtocol.emptyStats().toMutableMap().apply{put("viewportGranted",1);put("photoOccluded",7)}
        val report=DesktopSummary.create("DONE",1,DesktopReply("OK","DONE",emptyList(),stats)).report()
        assertTrue(report.contains("zasłonięte 7"));assertFalse(report.contains("fbcdn"))
        val json=org.json.JSONObject(stats);json.put("photoSelected",10001)
        assertNull(DesktopProtocol.parseStats(json))
        json.put("photoSelected",1);json.remove("photoSources")
        assertNull(DesktopProtocol.parseStats(json))
    }

    @Test fun version0522HistoryPadsExtractionAuditOnlyInRam(){
        val original=org.json.JSONObject(DesktopSummary.create("EMPTY",1).encode())
        val stats=original.getJSONObject("stats")
        for(key in DesktopProtocol.statKeys.drop(95))stats.remove(key)
        val raw=original.toString();val restored=DesktopSummary.decode(raw)!!
        for(key in DesktopProtocol.statKeys.drop(95))assertEquals(0,restored.stats.getValue(key))
        assertEquals(raw,original.toString())
        val values=DesktopProtocol.emptyStats().toMutableMap().apply{put("viewportGranted",1);put("photoOwnerRejected",5)}
        assertTrue(DesktopSummary.create("DONE",1,DesktopReply("OK","DONE",emptyList(),values)).report().contains("właściciel 5"))
    }

    @Test fun version0523HistoryDoesNotInventFastScrollingOrRewriteStoredData(){
        val old=org.json.JSONObject(DesktopSummary.create("EMPTY",1).encode())
        for(key in DesktopProtocol.statKeys.drop(104))old.getJSONObject("stats").remove(key)
        val raw=old.toString();val restored=DesktopSummary.decode(raw)!!
        assertEquals(0,restored.stats.getValue("scrollFast"));assertEquals(raw,old.toString())
        assertTrue(restored.report().contains("rytm DOM niezapisany"))
    }
    @Test fun sixtyStepsRequireTheExplicit500msAutomaticProtocol(){
        val stats=org.json.JSONObject(DesktopProtocol.emptyStats()).put("scrollSteps",60).put("scrollMoves",60)
        assertNull(DesktopProtocol.parseStats(stats))
        stats.put("scrollFast",1).put("scrollCadenceMs",500)
        assertNotNull(DesktopProtocol.parseStats(stats))
        stats.put("scrollSteps",61);assertNull(DesktopProtocol.parseStats(stats))
        stats.put("scrollSteps",60).put("gestureRequested",1);assertNull(DesktopProtocol.parseStats(stats))
        stats.put("gestureRequested",0).put("scrollCadenceMs",1000);assertNull(DesktopProtocol.parseStats(stats))
    }
    @Test fun fastReportShowsConfiguredCadenceAndPreservesNativeInputLimit(){
        val stats=DesktopProtocol.emptyStats().toMutableMap().apply{put("scrollFast",1);put("scrollCadenceMs",500)}
        assertTrue(DesktopSummary.create("EMPTY",1,DesktopReply("OK","DONE",emptyList(),stats)).report().contains("60 prób; rytm DOM 500 ms"))
        assertNull(DesktopProtocol.parseStats(org.json.JSONObject(stats).put("nativeRequests",31)))
    }

    @Test fun version0524HistoryDoesNotInventNetworkAnchorOrSvgEvidence(){
        val old=org.json.JSONObject(DesktopSummary.create("EMPTY",1).encode())
        for(key in DesktopProtocol.statKeys.drop(106))old.getJSONObject("stats").remove(key)
        val raw=old.toString();val restored=DesktopSummary.decode(raw)!!
        for(key in DesktopProtocol.statKeys.drop(106))assertEquals(0,restored.stats.getValue(key))
        assertEquals(raw,old.toString())
    }

}
