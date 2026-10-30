package pl.jakubokruszek.flipwatcher.geckopoc

/** No session/document input: only previously bound private crops. Never OCR a small thumbnail. */
object SavedOcr {
    suspend fun run(saved:SavedResult,consent:Boolean,alive:()->Boolean,
        read:suspend(SavedPhoto)->String?,project:suspend(String,List<String>)->DesktopRow?,now:()->Long,
        progress:(OcrSummary)->Unit={},checkpoint:(List<DesktopRow>)->Unit={}):OcrBatch.Outcome {
        val crops=saved.photos.filter{it.crop}.groupBy{it.postId}.mapValues{(_,v)->v.sortedBy{it.slot}.take(3)}
        val previous=saved.ocr.associateByTo(linkedMapOf()){it.postId}
        val outcome=OcrBatch.run(saved.rows,consent,{crops[it]?.size?:0},alive,
            read={id,index->crops[id]?.getOrNull(index)?.let{read(it)}},project=project,now=now,snapshot=progress,
            checkpoint={rows->
                val merged=previous.toMutableMap();merged.putAll(rows.filterValues{ReviewDataSummary.fields(it)>0})
                checkpoint(merged.values.toList())
            })
        val valid=outcome.rows.filterValues{ReviewDataSummary.fields(it)>0}
        return outcome.copy(summary=outcome.summary.copy(suggestions=valid.size),rows=valid)
    }
}
