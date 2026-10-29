package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject

/** One user-selected canonical post, numeric photo evidence only; never image URLs, HTML or OCR text. */
data class PhotoDiagnosis(val postId:String,val reason:String,val details:Map<String,Int>,val checks:Map<String,Int>){
    fun encode()=JSONObject().put("postId",postId).put("reason",reason).put("details",JSONObject(details)).put("checks",JSONObject(checks)).toString()
    fun report()="Post: $postId\nhttps://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/$postId/\nWynik zdjęcia: $reason\n"+
        (if(details.isEmpty())"Nie zebrano szczegółów obrazu. To nie dowód braku zdjęcia.\n" else
        "Widoczne elementy: IMG ${details.getValue("rawImg")} • SVG ${details.getValue("rawSvg")} • CSS ${details.getValue("rawCss")}\n"+
        "Źródła potwierdzonego posta: ${details.getValue("sourceProof")} • powiązane elementy ${details.getValue("ownerAccepted")} • odrzucone powiązanie ${details.getValue("ownerRejected")} • odrzucony rozmiar ${details.getValue("sizeRejected")} • zakwalifikowane ${details.getValue("qualified")}\n")+
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
