package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject

/** One user-selected canonical post, numeric photo evidence only; never image URLs, HTML or OCR text. */
data class PhotoDiagnosis(val postId:String,val reason:String,val details:Map<String,Int>,val checks:Map<String,Int>){
    fun encode()=JSONObject().put("postId",postId).put("reason",reason).put("details",JSONObject(details)).put("checks",JSONObject(checks)).toString()
    fun report()="Post: $postId\nhttps://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/$postId/\nWynik zdjęcia: $reason\n"+
        (if(details.isEmpty())"Nie zebrano szczegółów obrazu. To nie dowód braku zdjęcia.\n" else
        "IMG w otwartym dokumencie: ${details.getValue("documentImg")}\nSprawdzone elementy (także niepowiązane): IMG ${details.getValue("rawImg")} • SVG ${details.getValue("rawSvg")} • CSS ${details.getValue("rawCss")}\n"+
        "Źródła potwierdzonego posta: ${details.getValue("sourceProof")} • powiązane elementy ${details.getValue("ownerAccepted")} • odrzucone powiązanie ${details.getValue("ownerRejected")} • odrzucony rozmiar ${details.getValue("sizeRejected")} • zakwalifikowane ${details.getValue("qualified")}\n")+
        "Dopasowanie źródła: dokładne ${details["sourceExact"]?:0} • ten sam plik CDN ${details["sourceAsset"]?:0} • brak dopasowania ${details["sourceMiss"]?:0}\n"+
        "Kontener: brak article ${details["noArticle"]?:0} • jawny link wybranego posta ${details["anchorOwner"]?:0} • własne źródło bez linku ${details["sourceOwner"]?:0} • obca tożsamość ${details["foreignOwner"]?:0} • komentarz/cytat ${details["excludedOwner"]?:0}. Nowe liczniki są zerowe także dla prób ze starszej wersji.\n"+
        "Odrzucony obszar: brak właściwego ${details["regionMissing"]?:0} • niezależne obszary ${details["regionAmbiguous"]?:0} • ukryty ${details["regionHidden"]?:0} • wykluczony ${details["regionExcluded"]?:0} • limit przeglądania ${details["regionLimit"]?:0}.\n"+
        "Rodzaj limitu: liczba obszarów ${details["rootLimit"]?:0} • głębokość ${details["depthLimit"]?:0} • liczba linków ${details["anchorLimit"]?:0}. Dla starszych prób rodzaj limitu nie był mierzony.\n"+
        if(checks.isEmpty())"Etap zdjęcia nie został potwierdzony." else ReviewImageChecks.report(checks)
    companion object{
        fun decode(raw:String?):PhotoDiagnosis?=runCatching{
            if(raw==null||raw.length>4096)return null;val j=JSONObject(raw)
            if(j.keys().asSequence().toSet()!=setOf("postId","reason","details","checks"))return null
            val id=j.getString("postId");val reason=j.getString("reason")
            if(!Regex("[0-9]{5,30}").matches(id)||reason !in ReviewImageChecks.outcomes)return null
            val detail=j.getJSONObject("details");val checks=j.getJSONObject("checks")
            PhotoDiagnosis(id,reason,if(detail.length()==0)emptyMap() else ReviewImageChecks.details(JSONObject().put("details",detail))?:return null,
                if(checks.length()==0)emptyMap()else ReviewImageChecks.parse(checks)?:return null)
        }.getOrNull()
    }
}
