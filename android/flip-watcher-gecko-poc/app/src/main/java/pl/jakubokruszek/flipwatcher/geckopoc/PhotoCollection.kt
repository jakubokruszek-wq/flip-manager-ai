package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject

/** Reuses retained exact links: offers without a photo first, then unclassified candidates. */
object PhotoCollection {
    private fun valid(rows:List<DesktopRow>,group:String)=rows.size<=20&&rows.map{it.postId}.distinct().size==rows.size&&rows.all{
        it.permalink=="https://www.facebook.com/groups/$group/posts/${it.postId}/"&&ReviewDataGate.matches(it.permalink,group,it.postId)
    }
    private fun candidate(row:DesktopRow)=DesktopSummary.eligible(row)||DesktopPresentation.reviewable(row)
    fun queue(rows:List<DesktopRow>,hasPhoto:(String)->Boolean,group:String=PocPolicy.APPROVED_GROUP_ID):List<DesktopRow> {
        if(!valid(rows,group))return emptyList()
        return rows.filter{candidate(it)&&!hasPhoto(it.postId)}.sortedBy{if(DesktopSummary.eligible(it))0 else 1}
    }
    fun selected(rows:List<DesktopRow>,ids:List<String>,group:String):List<DesktopRow> {
        if(!valid(rows,group)||ids.isEmpty()||ids.size>20||ids.distinct().size!=ids.size)return emptyList()
        val byId=rows.associateBy{it.postId}
        if(ids.any{byId[it]?.let(::candidate)!=true})return emptyList()
        return ids.map{byId.getValue(it)}
    }
    /** Pixel ownership is temporary; durable save completes before the next post. No OCR here. */
    suspend fun capture(id:String,alive:()->Boolean,capture:suspend(DesktopThumbnails)->Boolean,
                        persist:suspend(DesktopThumbnails)->Boolean,publish:(DesktopThumbnails)->Unit={}):Boolean {
        val images=DesktopThumbnails()
        try {
            check(alive()){"PHOTO_CONTEXT"}
            check(capture(images)&&alive()){"PHOTO_CONTEXT"}
            if(images.rows(id).isEmpty())return false
            check(persist(images)){"PHOTO_SAVE"}
            // A completed save survives a later pause or session loss.
            if(alive())publish(images)
            return true
        } finally { images.clear() }
    }
}

/** Count-only photo progress, separate from OCR and business fields. */
data class PhotoSummary(val reason:String,val selected:Int,val saved:Int,val checks:Map<String,Int> = emptyMap(),val review:ReviewDataSummary?=null) {
    fun encode()=JSONObject().put("reason",reason).put("selected",selected).put("saved",saved).put("checks",JSONObject(checks)).apply{review?.let{put("review",JSONObject(it.encode()))}}.toString()
    fun brief()=buildString {
        appendLine("Zdjęcia ofert: $reason")
        appendLine("Zapisano nowe zdjęcia: $saved • sprawdzono: ${checks["checked"]?:0}/$selected postów")
        review?.let{appendLine("Otwarto: ${it.opened}/${it.selected} • potwierdzono: ${it.bound}")}
        append("Zdjęcia zapisane lokalnie. OCR nie był uruchamiany. Wcześniejsze wyniki pozostają w bazie; zapis usuwa Kasuj bazę.")
    }
    fun report()=brief()+"\n\n"+(if(checks.isEmpty())"Nie rozpoczęto sprawdzania zdjęć."else ReviewImageChecks.report(checks))+(review?.let{"\n\n"+it.report()}?:"")
    companion object {
        private val reasons=setOf("INTERRUPTED","DONE","PAUSED","CANCELLED","TIMEOUT","CONTEXT","ERROR")
        fun decode(raw:String?):PhotoSummary?=runCatching {
            if(raw==null||raw.length>4096)return null
            val j=JSONObject(raw);val fields=j.keys().asSequence().toSet();val required=setOf("reason","selected","saved","checks")
            if(fields!=required&&fields!=required+"review")return null
            val reason=j.opt("reason");val selected=j.opt("selected");val saved=j.opt("saved")
            if(reason !is String||reason !in reasons||selected !is Int||selected !in 0..20||saved !is Int||saved !in 0..selected)return null
            val c=j.optJSONObject("checks")?:return null
            val checks=if(c.length()==0)emptyMap()else ReviewImageChecks.parse(c)?:return null
            if((checks["checked"]?:0)>selected||saved>(checks["CAPTURED"]?:0))return null
            val review=if(j.has("review"))ReviewDataSummary.decode(j.getJSONObject("review").toString())?:return null else null
            if(review!=null&&(review.selected!=selected||reason=="DONE"&&review.reason!="DONE"))return null
            PhotoSummary(reason,selected,saved,checks,review)
        }.getOrNull()
    }
}
